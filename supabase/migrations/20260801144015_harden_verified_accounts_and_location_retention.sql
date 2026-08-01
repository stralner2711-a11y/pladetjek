begin;

-- Persistent community submissions must be attributable to an e-mail-confirmed
-- account. Anonymous sessions may still scan and read through the existing RPCs.
create or replace function private.require_verified_submission_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  if tg_nargs < 1 then
    raise exception 'SUBMISSION_OWNER_COLUMN_REQUIRED' using errcode = '22023';
  end if;

  if tg_nargs > 1
    and tg_argv[1] = 'alert_only'
    and coalesce(pg_catalog.to_jsonb(new) ->> 'source', '') <> 'alert'
  then
    return new;
  end if;

  v_user_id := nullif(
    pg_catalog.to_jsonb(new) ->> tg_argv[0],
    ''
  )::uuid;

  if v_user_id is null or not exists (
    select 1
    from auth.users as auth_user
    where auth_user.id = v_user_id
      and coalesce(auth_user.is_anonymous, true) = false
      and auth_user.email_confirmed_at is not null
  ) then
    raise exception 'PERMANENT_ACCOUNT_REQUIRED' using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function private.require_verified_submission_owner()
  from public, anon, authenticated, service_role;

drop trigger if exists require_verified_plate_alert_owner
  on public.plate_alerts;
create trigger require_verified_plate_alert_owner
  before insert or update of reporter_id on public.plate_alerts
  for each row execute function private.require_verified_submission_owner('reporter_id');

drop trigger if exists require_verified_alert_observation_owner
  on private.plate_observations;
create trigger require_verified_alert_observation_owner
  before insert or update of observed_by, source on private.plate_observations
  for each row execute function private.require_verified_submission_owner(
    'observed_by',
    'alert_only'
  );

drop trigger if exists require_verified_alert_report_owner
  on private.alert_reports;
create trigger require_verified_alert_report_owner
  before insert or update of reported_by on private.alert_reports
  for each row execute function private.require_verified_submission_owner('reported_by');

-- Exact nearby positions are operational data, not history. Stale device rows
-- are disabled and scrubbed; expired match events are deleted with their queue
-- rows through the existing ON DELETE CASCADE relationship.
create or replace function private.cleanup_expired_nearby_data_internal()
returns table (
  disabled_devices integer,
  deleted_events integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_disabled_devices integer := 0;
  v_deleted_events integer := 0;
begin
  update private.nearby_devices as device
  set
    push_token = null,
    notifications_enabled = false,
    last_latitude = null,
    last_longitude = null,
    location_accuracy_meters = null,
    location_updated_at = null,
    token_updated_at = null,
    updated_at = now()
  where device.location_updated_at < now() - interval '30 minutes'
    and (
      device.push_token is not null
      or device.last_latitude is not null
      or device.last_longitude is not null
      or device.location_accuracy_meters is not null
    );
  get diagnostics v_disabled_devices = row_count;

  delete from private.nearby_match_events as event
  where event.expires_at <= now();
  get diagnostics v_deleted_events = row_count;

  return query select v_disabled_devices, v_deleted_events;
end;
$$;

revoke all on function private.cleanup_expired_nearby_data_internal()
  from public, anon, authenticated;
grant execute on function private.cleanup_expired_nearby_data_internal()
  to service_role;

comment on function private.cleanup_expired_nearby_data_internal() is
  'Scrubs nearby device coordinates after 30 minutes and deletes expired nearby match events.';

-- Schedule the cleanup when pg_cron is already enabled. The migration remains
-- deployable without the extension and reports a notice instead of enabling it.
do $$
declare
  v_job_id bigint;
  v_unscheduled boolean;
begin
  if exists (
    select 1
    from pg_catalog.pg_extension
    where extname = 'pg_cron'
  ) then
    for v_job_id in execute
      'select jobid from cron.job where jobname = $1'
      using 'pladetjek_cleanup_expired_nearby_data'
    loop
      execute 'select cron.unschedule($1)'
        into v_unscheduled
        using v_job_id;
    end loop;

    execute 'select cron.schedule($1, $2, $3)'
      into v_job_id
      using
        'pladetjek_cleanup_expired_nearby_data',
        '*/10 * * * *',
        'select * from private.cleanup_expired_nearby_data_internal()';
  else
    raise notice 'pg_cron is not enabled; schedule private.cleanup_expired_nearby_data_internal() after enabling Cron';
  end if;
end;
$$;

select * from private.cleanup_expired_nearby_data_internal();

commit;
