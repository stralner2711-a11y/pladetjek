begin;

create table if not exists private.plate_observations (
  id uuid primary key default gen_random_uuid(),
  alert_id uuid not null references public.plate_alerts(id) on delete cascade,
  observed_by uuid not null references auth.users(id) on delete cascade,
  source text not null check (source in ('alert', 'camera')),
  observed_at timestamptz not null default now()
);

create index if not exists plate_observations_alert_time_idx
  on private.plate_observations (alert_id, observed_at desc);
create index if not exists plate_observations_user_time_idx
  on private.plate_observations (observed_by, observed_at desc);

alter table private.plate_observations enable row level security;
revoke all on table private.plate_observations from public, anon, authenticated;

insert into private.plate_observations (alert_id, observed_by, source, observed_at)
select alert.id, alert.reporter_id, 'alert', alert.created_at
from public.plate_alerts as alert
where not exists (
  select 1
  from private.plate_observations as observation
  where observation.alert_id = alert.id
    and observation.observed_by = alert.reporter_id
    and observation.source = 'alert'
);

create table if not exists private.alert_reports (
  id uuid primary key default gen_random_uuid(),
  alert_id uuid not null references public.plate_alerts(id) on delete cascade,
  reported_by uuid not null references auth.users(id) on delete cascade,
  reason text not null,
  status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'dismissed')),
  resolution_note text,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint alert_reports_reason_length
    check (pg_catalog.char_length(reason) between 10 and 300),
  constraint alert_reports_resolution_length
    check (
      resolution_note is null
      or pg_catalog.char_length(resolution_note) between 3 and 500
    )
);

create unique index if not exists alert_reports_one_pending_per_user
  on private.alert_reports (alert_id, reported_by)
  where status = 'pending';
create index if not exists alert_reports_queue_idx
  on private.alert_reports (status, created_at desc);

alter table private.alert_reports enable row level security;
revoke all on table private.alert_reports from public, anon, authenticated;

create table if not exists private.user_reputation (
  user_id uuid primary key references auth.users(id) on delete cascade,
  score integer not null default 50 check (score between 0 and 100),
  confirmed_reports integer not null default 0 check (confirmed_reports >= 0),
  dismissed_reports integer not null default 0 check (dismissed_reports >= 0),
  updated_at timestamptz not null default now()
);

insert into private.user_reputation (user_id)
select auth_user.id
from auth.users as auth_user
on conflict (user_id) do nothing;

alter table private.user_reputation enable row level security;
revoke all on table private.user_reputation from public, anon, authenticated;

create table if not exists private.moderation_audit (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  target_type text not null check (target_type in ('user', 'alert', 'report')),
  target_user_id uuid references auth.users(id) on delete set null,
  target_alert_id uuid references public.plate_alerts(id) on delete set null,
  target_report_id uuid references private.alert_reports(id) on delete set null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists moderation_audit_created_idx
  on private.moderation_audit (created_at desc);

alter table private.moderation_audit enable row level security;
revoke all on table private.moderation_audit from public, anon, authenticated;

create or replace function private.audit_account_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
begin
  if tg_table_name = 'account_moderation'
    and old.status is distinct from new.status then
    insert into private.moderation_audit (
      actor_id,
      action,
      target_type,
      target_user_id,
      details
    )
    values (
      coalesce(new.updated_by, v_actor_id),
      'user_status_changed',
      'user',
      new.user_id,
      pg_catalog.jsonb_build_object(
        'from', old.status,
        'to', new.status,
        'reason', new.reason
      )
    );
  elsif tg_table_name = 'user_roles'
    and old.role is distinct from new.role then
    insert into private.moderation_audit (
      actor_id,
      action,
      target_type,
      target_user_id,
      details
    )
    values (
      v_actor_id,
      'user_role_changed',
      'user',
      new.user_id,
      pg_catalog.jsonb_build_object('from', old.role, 'to', new.role)
    );
  end if;
  return new;
end;
$$;

revoke all on function private.audit_account_change()
  from public, anon, authenticated;

drop trigger if exists audit_account_moderation_change
  on private.account_moderation;
create trigger audit_account_moderation_change
  after update on private.account_moderation
  for each row execute function private.audit_account_change();

drop trigger if exists audit_user_role_change
  on private.user_roles;
create trigger audit_user_role_change
  after update on private.user_roles
  for each row execute function private.audit_account_change();

create or replace function private.create_plate_alert_v2_internal(
  p_plate text,
  p_description text
)
returns table (
  id uuid,
  plate text,
  description text,
  created_at timestamptz,
  expires_at timestamptz,
  duplicate boolean,
  observation_count bigint,
  distinct_reporter_count bigint,
  last_seen_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_alert record;
begin
  select *
  into v_alert
  from private.create_plate_alert_internal(p_plate, p_description);

  if v_alert.id is null then
    return;
  end if;

  insert into private.plate_observations (
    alert_id,
    observed_by,
    source,
    observed_at
  )
  select v_alert.id, v_user_id, 'alert', now()
  where not exists (
    select 1
    from private.plate_observations as observation
    where observation.alert_id = v_alert.id
      and observation.observed_by = v_user_id
      and observation.source = 'alert'
      and observation.observed_at >= now() - interval '10 minutes'
  );

  return query
    select
      v_alert.id::uuid,
      v_alert.plate::text,
      v_alert.description::text,
      v_alert.created_at::timestamptz,
      v_alert.expires_at::timestamptz,
      v_alert.duplicate::boolean,
      pg_catalog.count(observation.id)::bigint,
      pg_catalog.count(distinct observation.observed_by)::bigint,
      pg_catalog.max(observation.observed_at)
    from private.plate_observations as observation
    where observation.alert_id = v_alert.id;
end;
$$;

revoke all on function private.create_plate_alert_v2_internal(text, text)
  from public, anon, authenticated;
grant execute on function private.create_plate_alert_v2_internal(text, text)
  to authenticated;

create or replace function private.match_plate_alert_v4_internal(
  p_plate text,
  p_installation_id uuid default null,
  p_latitude double precision default null,
  p_longitude double precision default null,
  p_accuracy_meters double precision default null
)
returns table (
  id uuid,
  plate text,
  description text,
  created_at timestamptz,
  expires_at timestamptz,
  reporter_name text,
  notification_event_id uuid,
  observed_at timestamptz,
  notifications_queued boolean,
  observation_count bigint,
  distinct_reporter_count bigint,
  last_seen_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_match record;
  v_camera_match boolean := (
    p_installation_id is not null
    and p_latitude is not null
    and p_longitude is not null
    and p_accuracy_meters is not null
  );
begin
  if v_camera_match then
    select *
    into v_match
    from private.match_plate_alert_v3_internal(
      p_plate,
      p_installation_id,
      p_latitude,
      p_longitude,
      p_accuracy_meters
    );
  else
    select
      base.id,
      base.plate,
      base.description,
      base.created_at,
      base.expires_at,
      base.reporter_name,
      null::uuid as notification_event_id,
      null::timestamptz as observed_at,
      false as notifications_queued
    into v_match
    from private.match_plate_alert_v2_internal(p_plate) as base;
  end if;

  if v_match.id is null then
    return;
  end if;

  if v_camera_match then
    insert into private.plate_observations (
      alert_id,
      observed_by,
      source,
      observed_at
    )
    select v_match.id, v_user_id, 'camera', now()
    where not exists (
      select 1
      from private.plate_observations as observation
      where observation.alert_id = v_match.id
        and observation.observed_by = v_user_id
        and observation.source = 'camera'
        and observation.observed_at >= now() - interval '15 minutes'
    );
  end if;

  return query
    select
      v_match.id::uuid,
      v_match.plate::text,
      v_match.description::text,
      v_match.created_at::timestamptz,
      v_match.expires_at::timestamptz,
      v_match.reporter_name::text,
      v_match.notification_event_id::uuid,
      v_match.observed_at::timestamptz,
      coalesce(v_match.notifications_queued, false)::boolean,
      pg_catalog.count(observation.id)::bigint,
      pg_catalog.count(distinct observation.observed_by)::bigint,
      pg_catalog.max(observation.observed_at)
    from private.plate_observations as observation
    where observation.alert_id = v_match.id;
end;
$$;

revoke all on function private.match_plate_alert_v4_internal(
  text,
  uuid,
  double precision,
  double precision,
  double precision
) from public, anon, authenticated;
grant execute on function private.match_plate_alert_v4_internal(
  text,
  uuid,
  double precision,
  double precision,
  double precision
) to authenticated;

create or replace function private.report_plate_alert_internal(
  p_alert_id uuid,
  p_reason text
)
returns table (
  report_id uuid,
  report_status text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_status text;
  v_reason text := pg_catalog.btrim(
    pg_catalog.regexp_replace(
      coalesce(p_reason, ''),
      '[[:space:]]+',
      ' ',
      'g'
    )
  );
  v_report private.alert_reports%rowtype;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  select moderation.status
  into v_status
  from private.account_moderation as moderation
  where moderation.user_id = v_user_id;

  if coalesce(v_status, 'suspended') <> 'active' then
    raise exception 'ACCOUNT_SUSPENDED' using errcode = '42501';
  end if;

  if pg_catalog.char_length(v_reason) not between 10 and 300 then
    raise exception 'INVALID_REPORT_REASON' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.plate_alerts as alert
    where alert.id = p_alert_id
  ) then
    raise exception 'ALERT_NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into private.alert_reports (
    alert_id,
    reported_by,
    reason
  )
  values (p_alert_id, v_user_id, v_reason)
  on conflict (alert_id, reported_by) where status = 'pending'
  do update set reason = excluded.reason
  returning * into v_report;

  update public.user_profiles as profile
  set last_active_at = now()
  where profile.user_id = v_user_id;

  return query
    select v_report.id, v_report.status, v_report.created_at;
end;
$$;

revoke all on function private.report_plate_alert_internal(uuid, text)
  from public, anon, authenticated;
grant execute on function private.report_plate_alert_internal(uuid, text)
  to authenticated;

create or replace function private.admin_list_users_v2_internal(
  p_search text default '',
  p_status text default 'all',
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  user_id uuid,
  email text,
  username text,
  role text,
  account_status text,
  hide_from_peers boolean,
  created_at timestamptz,
  last_sign_in_at timestamptz,
  last_active_at timestamptz,
  is_anonymous boolean,
  total_count bigint,
  reputation_score integer,
  trust_level text,
  alert_count bigint,
  pending_report_count bigint
)
language sql
security definer
set search_path = ''
as $$
  select
    base.user_id,
    base.email,
    base.username,
    base.role,
    base.account_status,
    base.hide_from_peers,
    base.created_at,
    base.last_sign_in_at,
    base.last_active_at,
    base.is_anonymous,
    base.total_count,
    coalesce(reputation.score, 50),
    case
      when coalesce(reputation.score, 50) >= 80 then 'trusted'
      when coalesce(reputation.score, 50) >= 50 then 'established'
      else 'watch'
    end::text,
    (
      select pg_catalog.count(*)
      from public.plate_alerts as alert
      where alert.reporter_id = base.user_id
    )::bigint,
    (
      select pg_catalog.count(*)
      from private.alert_reports as report
      join public.plate_alerts as alert on alert.id = report.alert_id
      where alert.reporter_id = base.user_id
        and report.status = 'pending'
    )::bigint
  from private.admin_list_users_internal(
    p_search,
    p_status,
    p_limit,
    p_offset
  ) as base
  left join private.user_reputation as reputation
    on reputation.user_id = base.user_id;
$$;

revoke all on function private.admin_list_users_v2_internal(text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function private.admin_list_users_v2_internal(text, text, integer, integer)
  to authenticated;

create or replace function private.admin_list_alerts_internal(
  p_search text default '',
  p_status text default 'all',
  p_limit integer default 100,
  p_offset integer default 0
)
returns table (
  alert_id uuid,
  plate text,
  description text,
  reporter_id uuid,
  reporter_email text,
  reporter_username text,
  is_active boolean,
  created_at timestamptz,
  observation_count bigint,
  distinct_reporter_count bigint,
  report_count bigint,
  reputation_score integer,
  total_count bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller_id uuid := auth.uid();
  v_role text;
  v_search text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_search, '')));
  v_status text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_status, 'all')));
begin
  select user_role.role into v_role
  from private.user_roles as user_role
  where user_role.user_id = v_caller_id;

  if v_role not in ('admin', 'creator') then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if v_status not in ('all', 'active', 'inactive') then
    raise exception 'INVALID_STATUS' using errcode = '22023';
  end if;

  return query
    select
      alert.id,
      alert.plate,
      alert.description,
      alert.reporter_id,
      auth_user.email::text,
      profile.username,
      alert.is_active,
      alert.created_at,
      (
        select pg_catalog.count(*)
        from private.plate_observations as observation
        where observation.alert_id = alert.id
      )::bigint,
      (
        select pg_catalog.count(distinct observation.observed_by)
        from private.plate_observations as observation
        where observation.alert_id = alert.id
      )::bigint,
      (
        select pg_catalog.count(*)
        from private.alert_reports as report
        where report.alert_id = alert.id
          and report.status = 'pending'
      )::bigint,
      coalesce(reputation.score, 50),
      pg_catalog.count(*) over()
    from public.plate_alerts as alert
    join auth.users as auth_user on auth_user.id = alert.reporter_id
    join public.user_profiles as profile on profile.user_id = alert.reporter_id
    left join private.user_reputation as reputation
      on reputation.user_id = alert.reporter_id
    where
      (
        v_status = 'all'
        or (v_status = 'active' and alert.is_active = true)
        or (v_status = 'inactive' and alert.is_active = false)
      )
      and (
        v_search = ''
        or pg_catalog.lower(alert.plate) like '%' || v_search || '%'
        or pg_catalog.lower(alert.description) like '%' || v_search || '%'
        or pg_catalog.lower(coalesce(profile.username, '')) like '%' || v_search || '%'
        or pg_catalog.lower(coalesce(auth_user.email, '')) like '%' || v_search || '%'
      )
    order by alert.created_at desc
    limit greatest(1, least(coalesce(p_limit, 100), 200))
    offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

revoke all on function private.admin_list_alerts_internal(text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function private.admin_list_alerts_internal(text, text, integer, integer)
  to authenticated;

create or replace function private.admin_set_alert_status_internal(
  p_alert_id uuid,
  p_is_active boolean,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller_id uuid := auth.uid();
  v_role text;
  v_previous boolean;
begin
  select user_role.role into v_role
  from private.user_roles as user_role
  where user_role.user_id = v_caller_id;
  if v_role not in ('admin', 'creator') then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  select alert.is_active into v_previous
  from public.plate_alerts as alert
  where alert.id = p_alert_id
  for update;
  if not found then
    raise exception 'ALERT_NOT_FOUND' using errcode = 'P0002';
  end if;

  update public.plate_alerts
  set is_active = coalesce(p_is_active, false)
  where id = p_alert_id;

  insert into private.moderation_audit (
    actor_id,
    action,
    target_type,
    target_alert_id,
    details
  )
  values (
    v_caller_id,
    'alert_status_changed',
    'alert',
    p_alert_id,
    pg_catalog.jsonb_build_object(
      'from', v_previous,
      'to', coalesce(p_is_active, false),
      'note', nullif(pg_catalog.btrim(coalesce(p_note, '')), '')
    )
  );
end;
$$;

revoke all on function private.admin_set_alert_status_internal(uuid, boolean, text)
  from public, anon, authenticated;
grant execute on function private.admin_set_alert_status_internal(uuid, boolean, text)
  to authenticated;

create or replace function private.admin_list_alert_reports_internal(
  p_status text default 'pending',
  p_limit integer default 100,
  p_offset integer default 0
)
returns table (
  report_id uuid,
  report_status text,
  reason text,
  created_at timestamptz,
  reviewed_at timestamptz,
  resolution_note text,
  alert_id uuid,
  plate text,
  alert_description text,
  alert_is_active boolean,
  alert_reporter_id uuid,
  alert_reporter_email text,
  reported_by uuid,
  reported_by_email text,
  total_count bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_status text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_status, 'pending')));
begin
  select user_role.role into v_role
  from private.user_roles as user_role
  where user_role.user_id = auth.uid();
  if v_role not in ('admin', 'creator') then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if v_status not in ('all', 'pending', 'confirmed', 'dismissed') then
    raise exception 'INVALID_STATUS' using errcode = '22023';
  end if;

  return query
    select
      report.id,
      report.status,
      report.reason,
      report.created_at,
      report.reviewed_at,
      report.resolution_note,
      alert.id,
      alert.plate,
      alert.description,
      alert.is_active,
      alert.reporter_id,
      alert_owner.email::text,
      report.reported_by,
      report_owner.email::text,
      pg_catalog.count(*) over()
    from private.alert_reports as report
    join public.plate_alerts as alert on alert.id = report.alert_id
    join auth.users as alert_owner on alert_owner.id = alert.reporter_id
    join auth.users as report_owner on report_owner.id = report.reported_by
    where v_status = 'all' or report.status = v_status
    order by
      case when report.status = 'pending' then 0 else 1 end,
      report.created_at desc
    limit greatest(1, least(coalesce(p_limit, 100), 200))
    offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

revoke all on function private.admin_list_alert_reports_internal(text, integer, integer)
  from public, anon, authenticated;
grant execute on function private.admin_list_alert_reports_internal(text, integer, integer)
  to authenticated;

create or replace function private.admin_resolve_alert_report_internal(
  p_report_id uuid,
  p_resolution text,
  p_note text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller_id uuid := auth.uid();
  v_role text;
  v_resolution text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_resolution, '')));
  v_note text := pg_catalog.btrim(coalesce(p_note, ''));
  v_report private.alert_reports%rowtype;
  v_alert public.plate_alerts%rowtype;
begin
  select user_role.role into v_role
  from private.user_roles as user_role
  where user_role.user_id = v_caller_id;
  if v_role not in ('admin', 'creator') then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if v_resolution not in ('confirmed', 'dismissed') then
    raise exception 'INVALID_RESOLUTION' using errcode = '22023';
  end if;
  if pg_catalog.char_length(v_note) not between 3 and 500 then
    raise exception 'INVALID_NOTE' using errcode = '22023';
  end if;

  select * into v_report
  from private.alert_reports
  where id = p_report_id
  for update;
  if not found then
    raise exception 'REPORT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_report.status <> 'pending' then
    raise exception 'REPORT_ALREADY_RESOLVED' using errcode = 'P0001';
  end if;

  select * into v_alert
  from public.plate_alerts
  where id = v_report.alert_id
  for update;

  update private.alert_reports
  set
    status = v_resolution,
    resolution_note = v_note,
    reviewed_by = v_caller_id,
    reviewed_at = now()
  where id = p_report_id;

  if v_resolution = 'confirmed' then
    update public.plate_alerts
    set is_active = false
    where id = v_report.alert_id;

    insert into private.user_reputation (user_id, score, confirmed_reports)
    values (v_report.reported_by, 52, 1)
    on conflict (user_id) do update
    set
      score = least(100, private.user_reputation.score + 2),
      confirmed_reports = private.user_reputation.confirmed_reports + 1,
      updated_at = now();

    insert into private.user_reputation (user_id, score)
    values (v_alert.reporter_id, 40)
    on conflict (user_id) do update
    set
      score = greatest(0, private.user_reputation.score - 10),
      updated_at = now();
  else
    insert into private.user_reputation (user_id, score, dismissed_reports)
    values (v_report.reported_by, 48, 1)
    on conflict (user_id) do update
    set
      score = greatest(0, private.user_reputation.score - 2),
      dismissed_reports = private.user_reputation.dismissed_reports + 1,
      updated_at = now();
  end if;

  insert into private.moderation_audit (
    actor_id,
    action,
    target_type,
    target_alert_id,
    target_report_id,
    details
  )
  values (
    v_caller_id,
    'alert_report_resolved',
    'report',
    v_report.alert_id,
    p_report_id,
    pg_catalog.jsonb_build_object(
      'resolution', v_resolution,
      'note', v_note
    )
  );
end;
$$;

revoke all on function private.admin_resolve_alert_report_internal(uuid, text, text)
  from public, anon, authenticated;
grant execute on function private.admin_resolve_alert_report_internal(uuid, text, text)
  to authenticated;

create or replace function private.admin_list_moderation_audit_internal(
  p_limit integer default 100
)
returns table (
  audit_id uuid,
  actor_id uuid,
  actor_email text,
  action text,
  target_type text,
  target_user_id uuid,
  target_alert_id uuid,
  target_report_id uuid,
  details jsonb,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
begin
  select user_role.role into v_role
  from private.user_roles as user_role
  where user_role.user_id = auth.uid();
  if v_role not in ('admin', 'creator') then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  return query
    select
      audit.id,
      audit.actor_id,
      actor.email::text,
      audit.action,
      audit.target_type,
      audit.target_user_id,
      audit.target_alert_id,
      audit.target_report_id,
      audit.details,
      audit.created_at
    from private.moderation_audit as audit
    left join auth.users as actor on actor.id = audit.actor_id
    order by audit.created_at desc
    limit greatest(1, least(coalesce(p_limit, 100), 200));
end;
$$;

revoke all on function private.admin_list_moderation_audit_internal(integer)
  from public, anon, authenticated;
grant execute on function private.admin_list_moderation_audit_internal(integer)
  to authenticated;

create or replace function public.create_plate_alert_v2(
  p_plate text,
  p_description text
)
returns table (
  id uuid,
  plate text,
  description text,
  created_at timestamptz,
  expires_at timestamptz,
  duplicate boolean,
  observation_count bigint,
  distinct_reporter_count bigint,
  last_seen_at timestamptz
)
language sql
security invoker
set search_path = ''
as $$
  select * from private.create_plate_alert_v2_internal(p_plate, p_description);
$$;

revoke all on function public.create_plate_alert_v2(text, text)
  from public, anon, authenticated;
grant execute on function public.create_plate_alert_v2(text, text)
  to authenticated;

create or replace function public.match_plate_alert_v4(
  p_plate text,
  p_installation_id uuid default null,
  p_latitude double precision default null,
  p_longitude double precision default null,
  p_accuracy_meters double precision default null
)
returns table (
  id uuid,
  plate text,
  description text,
  created_at timestamptz,
  expires_at timestamptz,
  reporter_name text,
  notification_event_id uuid,
  observed_at timestamptz,
  notifications_queued boolean,
  observation_count bigint,
  distinct_reporter_count bigint,
  last_seen_at timestamptz
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from private.match_plate_alert_v4_internal(
    p_plate,
    p_installation_id,
    p_latitude,
    p_longitude,
    p_accuracy_meters
  );
$$;

revoke all on function public.match_plate_alert_v4(
  text,
  uuid,
  double precision,
  double precision,
  double precision
) from public, anon, authenticated;
grant execute on function public.match_plate_alert_v4(
  text,
  uuid,
  double precision,
  double precision,
  double precision
) to authenticated;

create or replace function public.report_plate_alert(
  p_alert_id uuid,
  p_reason text
)
returns table (
  report_id uuid,
  report_status text,
  created_at timestamptz
)
language sql
security invoker
set search_path = ''
as $$
  select * from private.report_plate_alert_internal(p_alert_id, p_reason);
$$;

revoke all on function public.report_plate_alert(uuid, text)
  from public, anon, authenticated;
grant execute on function public.report_plate_alert(uuid, text)
  to authenticated;

create or replace function public.admin_list_users_v2(
  p_search text default '',
  p_status text default 'all',
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  user_id uuid,
  email text,
  username text,
  role text,
  account_status text,
  hide_from_peers boolean,
  created_at timestamptz,
  last_sign_in_at timestamptz,
  last_active_at timestamptz,
  is_anonymous boolean,
  total_count bigint,
  reputation_score integer,
  trust_level text,
  alert_count bigint,
  pending_report_count bigint
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from private.admin_list_users_v2_internal(
    p_search,
    p_status,
    p_limit,
    p_offset
  );
$$;

revoke all on function public.admin_list_users_v2(text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.admin_list_users_v2(text, text, integer, integer)
  to authenticated;

create or replace function public.admin_list_alerts(
  p_search text default '',
  p_status text default 'all',
  p_limit integer default 100,
  p_offset integer default 0
)
returns table (
  alert_id uuid,
  plate text,
  description text,
  reporter_id uuid,
  reporter_email text,
  reporter_username text,
  is_active boolean,
  created_at timestamptz,
  observation_count bigint,
  distinct_reporter_count bigint,
  report_count bigint,
  reputation_score integer,
  total_count bigint
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from private.admin_list_alerts_internal(
    p_search,
    p_status,
    p_limit,
    p_offset
  );
$$;

revoke all on function public.admin_list_alerts(text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.admin_list_alerts(text, text, integer, integer)
  to authenticated;

create or replace function public.admin_set_alert_status(
  p_alert_id uuid,
  p_is_active boolean,
  p_note text default null
)
returns void
language sql
security invoker
set search_path = ''
as $$
  select private.admin_set_alert_status_internal(
    p_alert_id,
    p_is_active,
    p_note
  );
$$;

revoke all on function public.admin_set_alert_status(uuid, boolean, text)
  from public, anon, authenticated;
grant execute on function public.admin_set_alert_status(uuid, boolean, text)
  to authenticated;

create or replace function public.admin_list_alert_reports(
  p_status text default 'pending',
  p_limit integer default 100,
  p_offset integer default 0
)
returns table (
  report_id uuid,
  report_status text,
  reason text,
  created_at timestamptz,
  reviewed_at timestamptz,
  resolution_note text,
  alert_id uuid,
  plate text,
  alert_description text,
  alert_is_active boolean,
  alert_reporter_id uuid,
  alert_reporter_email text,
  reported_by uuid,
  reported_by_email text,
  total_count bigint
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from private.admin_list_alert_reports_internal(
    p_status,
    p_limit,
    p_offset
  );
$$;

revoke all on function public.admin_list_alert_reports(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.admin_list_alert_reports(text, integer, integer)
  to authenticated;

create or replace function public.admin_resolve_alert_report(
  p_report_id uuid,
  p_resolution text,
  p_note text
)
returns void
language sql
security invoker
set search_path = ''
as $$
  select private.admin_resolve_alert_report_internal(
    p_report_id,
    p_resolution,
    p_note
  );
$$;

revoke all on function public.admin_resolve_alert_report(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.admin_resolve_alert_report(uuid, text, text)
  to authenticated;

create or replace function public.admin_list_moderation_audit(
  p_limit integer default 100
)
returns table (
  audit_id uuid,
  actor_id uuid,
  actor_email text,
  action text,
  target_type text,
  target_user_id uuid,
  target_alert_id uuid,
  target_report_id uuid,
  details jsonb,
  created_at timestamptz
)
language sql
security invoker
set search_path = ''
as $$
  select * from private.admin_list_moderation_audit_internal(p_limit);
$$;

revoke all on function public.admin_list_moderation_audit(integer)
  from public, anon, authenticated;
grant execute on function public.admin_list_moderation_audit(integer)
  to authenticated;

comment on table private.plate_observations is
  'Interne observationer bag sammenlagte Pladetjek-advarsler.';
comment on table private.alert_reports is
  'Beskyttet moderationskø for brugerindsendte fejlrapporter.';
comment on table private.user_reputation is
  'Internt troværdighedsniveau, kun til creator og administratorer.';
comment on table private.moderation_audit is
  'Uforanderlig revisionshistorik for administrative handlinger.';

commit;
