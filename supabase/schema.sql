begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;
grant usage on schema private to service_role;

-- Supabases automatiske RLS-hjælper bruges af et internt event-trigger.
-- Klientroller skal ikke kunne kalde SECURITY DEFINER-funktionen direkte.
do $$
begin
  if pg_catalog.to_regprocedure('public.rls_auto_enable()') is not null then
    execute
      'revoke execute on function public.rls_auto_enable() '
      'from public, anon, authenticated';
  end if;
end;
$$;

create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username text,
  hide_from_peers boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  constraint user_profiles_username_format
    check (
      username is null
      or (
        pg_catalog.char_length(username) between 3 and 24
        and username ~ '^[A-Za-zÆØÅæøå0-9_]+$'
      )
    )
);

create unique index if not exists user_profiles_username_unique
  on public.user_profiles (pg_catalog.lower(username))
  where username is not null;

alter table public.user_profiles enable row level security;
revoke all on table public.user_profiles from public, anon, authenticated;

create table if not exists private.user_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'user'
    check (role in ('user', 'admin', 'creator')),
  updated_at timestamptz not null default now()
);

alter table private.user_roles enable row level security;
revoke all on table private.user_roles from public, anon, authenticated;

create table if not exists private.account_moderation (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null default 'active'
    check (status in ('active', 'suspended')),
  reason text,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table private.account_moderation enable row level security;
revoke all on table private.account_moderation from public, anon, authenticated;

-- Creator-e-mailen indsættes manuelt i Supabase. Tabellen er aldrig eksponeret.
create table if not exists private.creator_allowlist (
  email text primary key,
  created_at timestamptz not null default now(),
  constraint creator_allowlist_lowercase
    check (email = pg_catalog.lower(pg_catalog.btrim(email)))
);

alter table private.creator_allowlist enable row level security;
revoke all on table private.creator_allowlist from public, anon, authenticated;

create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := 'user';
begin
  if new.email is not null and exists (
    select 1
    from private.creator_allowlist as allowlisted
    where allowlisted.email = pg_catalog.lower(pg_catalog.btrim(new.email))
  ) then
    v_role := 'creator';
  end if;

  insert into public.user_profiles (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  insert into private.user_roles (user_id, role)
  values (new.id, v_role)
  on conflict (user_id) do nothing;

  insert into private.account_moderation (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

revoke all on function private.handle_new_auth_user()
  from public, anon, authenticated;

create or replace trigger on_auth_user_created_pladetjek
  after insert on auth.users
  for each row execute function private.handle_new_auth_user();

insert into public.user_profiles (user_id, created_at, updated_at, last_active_at)
select auth_user.id, auth_user.created_at, auth_user.created_at, auth_user.created_at
from auth.users as auth_user
on conflict (user_id) do nothing;

insert into private.user_roles (user_id)
select auth_user.id
from auth.users as auth_user
on conflict (user_id) do nothing;

insert into private.account_moderation (user_id)
select auth_user.id
from auth.users as auth_user
on conflict (user_id) do nothing;

create or replace function private.assign_creator_by_email(p_email text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  v_user_id uuid;
begin
  if v_email = '' then
    raise exception 'INVALID_EMAIL' using errcode = '22023';
  end if;

  insert into private.creator_allowlist (email)
  values (v_email)
  on conflict (email) do nothing;

  select auth_user.id
  into v_user_id
  from auth.users as auth_user
  where pg_catalog.lower(auth_user.email) = v_email
  order by auth_user.created_at
  limit 1;

  if v_user_id is not null then
    update private.user_roles
    set role = 'creator', updated_at = now()
    where user_id = v_user_id;
  end if;

  return v_user_id;
end;
$$;

revoke all on function private.assign_creator_by_email(text)
  from public, anon, authenticated;

create table if not exists public.plate_alerts (
  id uuid primary key default gen_random_uuid(),
  plate text not null,
  description text not null,
  reporter_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '1 hour'),
  constraint plate_alerts_plate_format
    check (plate ~ '^[A-ZÆØÅ]{2}[0-9]{5}$'),
  constraint plate_alerts_description_length
    check (pg_catalog.char_length(description) between 5 and 240),
  constraint plate_alerts_expiry_window
    check (
      expires_at > created_at
      and expires_at <= created_at + interval '24 hours'
    )
);

create index if not exists plate_alerts_match_idx
  on public.plate_alerts (plate, expires_at desc);

create index if not exists plate_alerts_reporter_rate_idx
  on public.plate_alerts (reporter_id, created_at desc);

alter table public.plate_alerts enable row level security;
revoke all on table public.plate_alerts from public, anon, authenticated;

create table if not exists private.plate_match_rate_limits (
  user_id uuid primary key,
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0)
);

alter table private.plate_match_rate_limits enable row level security;
revoke all on table private.plate_match_rate_limits from public, anon, authenticated;

create table if not exists private.nearby_devices (
  user_id uuid not null references auth.users(id) on delete cascade,
  installation_id uuid not null,
  push_token text,
  notifications_enabled boolean not null default false,
  last_latitude double precision,
  last_longitude double precision,
  location_accuracy_meters double precision,
  location_updated_at timestamptz,
  token_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, installation_id),
  constraint nearby_devices_token_length
    check (push_token is null or pg_catalog.char_length(push_token) between 20 and 4096),
  constraint nearby_devices_latitude
    check (last_latitude is null or last_latitude between -90 and 90),
  constraint nearby_devices_longitude
    check (last_longitude is null or last_longitude between -180 and 180),
  constraint nearby_devices_accuracy
    check (
      location_accuracy_meters is null
      or location_accuracy_meters between 0 and 10000
    ),
  constraint nearby_devices_enabled_data
    check (
      notifications_enabled = false
      or (
        push_token is not null
        and last_latitude is not null
        and last_longitude is not null
        and location_updated_at is not null
      )
    )
);

create unique index if not exists nearby_devices_push_token_unique
  on private.nearby_devices (push_token)
  where push_token is not null;

create index if not exists nearby_devices_active_location_idx
  on private.nearby_devices (location_updated_at desc)
  where notifications_enabled = true;

alter table private.nearby_devices enable row level security;
revoke all on table private.nearby_devices from public, anon, authenticated;

create table if not exists private.nearby_match_events (
  id uuid primary key default gen_random_uuid(),
  alert_id uuid not null references public.plate_alerts(id) on delete cascade,
  plate text not null,
  matched_by uuid not null references auth.users(id) on delete cascade,
  exact_latitude double precision not null,
  exact_longitude double precision not null,
  location_accuracy_meters double precision not null,
  observed_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '1 hour'),
  constraint nearby_match_events_plate_format
    check (plate ~ '^[A-ZÆØÅ]{2}[0-9]{5}$'),
  constraint nearby_match_events_latitude
    check (exact_latitude between -90 and 90),
  constraint nearby_match_events_longitude
    check (exact_longitude between -180 and 180),
  constraint nearby_match_events_accuracy
    check (location_accuracy_meters between 0 and 10000),
  constraint nearby_match_events_expiry
    check (expires_at > observed_at and expires_at <= observed_at + interval '2 hours')
);

create index if not exists nearby_match_events_dedup_idx
  on private.nearby_match_events (alert_id, observed_at desc);

alter table private.nearby_match_events enable row level security;
revoke all on table private.nearby_match_events from public, anon, authenticated;

create table if not exists private.nearby_notification_queue (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references private.nearby_match_events(id) on delete cascade,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  recipient_installation_id uuid not null,
  push_token text not null,
  distance_meters integer not null check (distance_meters between 0 and 5000),
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'sent', 'failed')),
  attempts integer not null default 0 check (attempts between 0 and 5),
  claimed_at timestamptz,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  unique (event_id, recipient_user_id, recipient_installation_id),
  constraint nearby_notification_queue_token_length
    check (pg_catalog.char_length(push_token) between 20 and 4096)
);

create index if not exists nearby_notification_queue_claim_idx
  on private.nearby_notification_queue (event_id, status, created_at);

alter table private.nearby_notification_queue enable row level security;
revoke all on table private.nearby_notification_queue from public, anon, authenticated;

create or replace function private.distance_meters(
  p_latitude_a double precision,
  p_longitude_a double precision,
  p_latitude_b double precision,
  p_longitude_b double precision
)
returns double precision
language sql
immutable
strict
set search_path = ''
as $$
  select
    2.0 * 6371000.0 * pg_catalog.asin(
      least(
        1.0::double precision,
        pg_catalog.sqrt(
          pg_catalog.power(
            pg_catalog.sin(
              pg_catalog.radians(p_latitude_b - p_latitude_a) / 2.0
            ),
            2.0
          )
          + pg_catalog.cos(pg_catalog.radians(p_latitude_a))
          * pg_catalog.cos(pg_catalog.radians(p_latitude_b))
          * pg_catalog.power(
            pg_catalog.sin(
              pg_catalog.radians(p_longitude_b - p_longitude_a) / 2.0
            ),
            2.0
          )
        )
      )
    );
$$;

revoke all on function private.distance_meters(
  double precision,
  double precision,
  double precision,
  double precision
) from public, anon, authenticated;

create or replace function private.get_my_profile_internal()
returns table (
  user_id uuid,
  email text,
  username text,
  hide_from_peers boolean,
  role text,
  account_status text,
  created_at timestamptz,
  last_active_at timestamptz,
  is_anonymous boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  update public.user_profiles as profile
  set last_active_at = now()
  where profile.user_id = v_user_id;

  return query
    select
      auth_user.id,
      auth_user.email::text,
      profile.username,
      profile.hide_from_peers,
      user_role.role,
      moderation.status,
      auth_user.created_at,
      profile.last_active_at,
      (auth_user.email is null)
    from auth.users as auth_user
    join public.user_profiles as profile on profile.user_id = auth_user.id
    join private.user_roles as user_role on user_role.user_id = auth_user.id
    join private.account_moderation as moderation on moderation.user_id = auth_user.id
    where auth_user.id = v_user_id;
end;
$$;

revoke all on function private.get_my_profile_internal()
  from public, anon, authenticated;
grant execute on function private.get_my_profile_internal()
  to authenticated;

create or replace function private.save_my_profile_internal(
  p_username text,
  p_hide_from_peers boolean
)
returns table (
  user_id uuid,
  email text,
  username text,
  hide_from_peers boolean,
  role text,
  account_status text,
  created_at timestamptz,
  last_active_at timestamptz,
  is_anonymous boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_username text := pg_catalog.btrim(coalesce(p_username, ''));
  v_email text;
  v_status text;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  select auth_user.email, moderation.status
  into v_email, v_status
  from auth.users as auth_user
  join private.account_moderation as moderation on moderation.user_id = auth_user.id
  where auth_user.id = v_user_id;

  if v_email is null then
    raise exception 'PERMANENT_ACCOUNT_REQUIRED' using errcode = '42501';
  end if;

  if v_status <> 'active' then
    raise exception 'ACCOUNT_SUSPENDED' using errcode = '42501';
  end if;

  if pg_catalog.char_length(v_username) not between 3 and 24
    or v_username !~ '^[A-Za-zÆØÅæøå0-9_]+$' then
    raise exception 'INVALID_USERNAME' using errcode = '22023';
  end if;

  begin
    update public.user_profiles as profile
    set
      username = v_username,
      hide_from_peers = coalesce(p_hide_from_peers, true),
      updated_at = now(),
      last_active_at = now()
    where profile.user_id = v_user_id;
  exception
    when unique_violation then
      raise exception 'USERNAME_TAKEN' using errcode = '23505';
  end;

  return query select * from private.get_my_profile_internal();
end;
$$;

revoke all on function private.save_my_profile_internal(text, boolean)
  from public, anon, authenticated;
grant execute on function private.save_my_profile_internal(text, boolean)
  to authenticated;

create or replace function private.create_plate_alert_internal(
  p_plate text,
  p_description text
)
returns table (
  id uuid,
  plate text,
  description text,
  created_at timestamptz,
  expires_at timestamptz,
  duplicate boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_plate text := pg_catalog.upper(
    pg_catalog.regexp_replace(
      coalesce(p_plate, ''),
      '[^A-Za-zÆØÅæøå0-9]',
      '',
      'g'
    )
  );
  v_description text := pg_catalog.btrim(
    pg_catalog.regexp_replace(
      pg_catalog.regexp_replace(
        coalesce(p_description, ''),
        '[[:cntrl:]]+',
        ' ',
        'g'
      ),
      '[[:space:]]+',
      ' ',
      'g'
    )
  );
  v_existing public.plate_alerts%rowtype;
  v_created public.plate_alerts%rowtype;
  v_recent_count integer;
  v_status text;
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

  if v_plate !~ '^[A-ZÆØÅ]{2}[0-9]{5}$' then
    raise exception 'INVALID_PLATE' using errcode = '22023';
  end if;

  if pg_catalog.char_length(v_description) not between 5 and 240 then
    raise exception 'INVALID_DESCRIPTION' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_plate, 0)
  );

  delete from public.plate_alerts as expired_alert
  where expired_alert.expires_at <= now() - interval '24 hours';

  select alert.*
  into v_existing
  from public.plate_alerts as alert
  where alert.plate = v_plate
    and alert.expires_at > now()
    and alert.created_at >= now() - interval '15 minutes'
  order by alert.created_at desc
  limit 1;

  if found then
    return query
      select
        v_existing.id,
        v_existing.plate,
        v_existing.description,
        v_existing.created_at,
        v_existing.expires_at,
        true;
    return;
  end if;

  select pg_catalog.count(*)::integer
  into v_recent_count
  from public.plate_alerts as alert
  where alert.reporter_id = v_user_id
    and alert.created_at >= now() - interval '10 minutes';

  if v_recent_count >= 3 then
    raise exception 'RATE_LIMITED' using errcode = 'P0001';
  end if;

  insert into public.plate_alerts (
    plate,
    description,
    reporter_id,
    expires_at
  )
  values (
    v_plate,
    v_description,
    v_user_id,
    now() + interval '1 hour'
  )
  returning public.plate_alerts.* into v_created;

  update public.user_profiles as profile
  set last_active_at = now()
  where profile.user_id = v_user_id;

  return query
    select
      v_created.id,
      v_created.plate,
      v_created.description,
      v_created.created_at,
      v_created.expires_at,
      false;
end;
$$;

revoke all on function private.create_plate_alert_internal(text, text)
  from public, anon, authenticated;
grant execute on function private.create_plate_alert_internal(text, text)
  to authenticated;

create or replace function private.match_plate_alert_v2_internal(p_plate text)
returns table (
  id uuid,
  plate text,
  description text,
  created_at timestamptz,
  expires_at timestamptz,
  reporter_name text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_plate text := pg_catalog.upper(
    pg_catalog.regexp_replace(
      coalesce(p_plate, ''),
      '[^A-Za-zÆØÅæøå0-9]',
      '',
      'g'
    )
  );
  v_request_count integer;
  v_status text;
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

  if v_plate !~ '^[A-ZÆØÅ]{2}[0-9]{5}$' then
    raise exception 'INVALID_PLATE' using errcode = '22023';
  end if;

  insert into private.plate_match_rate_limits as rate_limit (
    user_id,
    window_started_at,
    request_count
  )
  values (v_user_id, now(), 1)
  on conflict (user_id) do update
  set
    window_started_at = case
      when rate_limit.window_started_at < now() - interval '1 minute'
        then now()
      else rate_limit.window_started_at
    end,
    request_count = case
      when rate_limit.window_started_at < now() - interval '1 minute'
        then 1
      else rate_limit.request_count + 1
    end
  returning request_count into v_request_count;

  if v_request_count > 120 then
    raise exception 'RATE_LIMITED' using errcode = 'P0001';
  end if;

  delete from private.plate_match_rate_limits
  where window_started_at < now() - interval '1 day'
    and user_id <> v_user_id;

  update public.user_profiles as profile
  set last_active_at = now()
  where profile.user_id = v_user_id;

  return query
    select
      alert.id,
      alert.plate,
      alert.description,
      alert.created_at,
      alert.expires_at,
      case
        when reporter.username is not null and reporter.hide_from_peers = false
          then reporter.username
        else 'Anonym bruger'
      end::text
    from public.plate_alerts as alert
    left join public.user_profiles as reporter
      on reporter.user_id = alert.reporter_id
    where alert.plate = v_plate
      and alert.expires_at > now()
    order by alert.created_at desc
    limit 1;
end;
$$;

revoke all on function private.match_plate_alert_v2_internal(text)
  from public, anon, authenticated;
grant execute on function private.match_plate_alert_v2_internal(text)
  to authenticated;

create or replace function private.set_nearby_device_internal(
  p_installation_id uuid,
  p_push_token text,
  p_enabled boolean,
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy_meters double precision
)
returns table (
  enabled boolean,
  location_updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_status text;
  v_token text := nullif(pg_catalog.btrim(coalesce(p_push_token, '')), '');
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  if p_installation_id is null then
    raise exception 'INVALID_INSTALLATION' using errcode = '22023';
  end if;

  select moderation.status
  into v_status
  from private.account_moderation as moderation
  where moderation.user_id = v_user_id;

  if coalesce(v_status, 'suspended') <> 'active' then
    raise exception 'ACCOUNT_SUSPENDED' using errcode = '42501';
  end if;

  if coalesce(p_enabled, false) = false then
    insert into private.nearby_devices (
      user_id,
      installation_id,
      notifications_enabled
    )
    values (v_user_id, p_installation_id, false)
    on conflict (user_id, installation_id) do update
    set
      push_token = null,
      notifications_enabled = false,
      last_latitude = null,
      last_longitude = null,
      location_accuracy_meters = null,
      location_updated_at = null,
      token_updated_at = null,
      updated_at = now();

    return query select false, null::timestamptz;
    return;
  end if;

  if v_token is null or pg_catalog.char_length(v_token) not between 20 and 4096 then
    raise exception 'INVALID_PUSH_TOKEN' using errcode = '22023';
  end if;

  if p_latitude is null or p_latitude not between -90 and 90
    or p_longitude is null or p_longitude not between -180 and 180
    or p_accuracy_meters is null or p_accuracy_meters not between 0 and 10000
  then
    raise exception 'INVALID_LOCATION' using errcode = '22023';
  end if;

  delete from private.nearby_devices as device
  where device.push_token = v_token
    and (
      device.user_id <> v_user_id
      or device.installation_id <> p_installation_id
    );

  insert into private.nearby_devices (
    user_id,
    installation_id,
    push_token,
    notifications_enabled,
    last_latitude,
    last_longitude,
    location_accuracy_meters,
    location_updated_at,
    token_updated_at
  )
  values (
    v_user_id,
    p_installation_id,
    v_token,
    true,
    p_latitude,
    p_longitude,
    p_accuracy_meters,
    now(),
    now()
  )
  on conflict (user_id, installation_id) do update
  set
    push_token = excluded.push_token,
    notifications_enabled = true,
    last_latitude = excluded.last_latitude,
    last_longitude = excluded.last_longitude,
    location_accuracy_meters = excluded.location_accuracy_meters,
    location_updated_at = excluded.location_updated_at,
    token_updated_at = excluded.token_updated_at,
    updated_at = now();

  update public.user_profiles as profile
  set last_active_at = now()
  where profile.user_id = v_user_id;

  return query select true, now();
end;
$$;

revoke all on function private.set_nearby_device_internal(
  uuid,
  text,
  boolean,
  double precision,
  double precision,
  double precision
) from public, anon, authenticated;
grant execute on function private.set_nearby_device_internal(
  uuid,
  text,
  boolean,
  double precision,
  double precision,
  double precision
) to authenticated;

create or replace function private.get_nearby_device_internal(
  p_installation_id uuid
)
returns table (
  enabled boolean,
  location_updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  return query
    select
      device.notifications_enabled,
      device.location_updated_at
    from private.nearby_devices as device
    where device.user_id = v_user_id
      and device.installation_id = p_installation_id
    limit 1;
end;
$$;

revoke all on function private.get_nearby_device_internal(uuid)
  from public, anon, authenticated;
grant execute on function private.get_nearby_device_internal(uuid)
  to authenticated;

create or replace function private.match_plate_alert_v3_internal(
  p_plate text,
  p_installation_id uuid,
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy_meters double precision
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
  notifications_queued boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_match record;
  v_existing_event private.nearby_match_events%rowtype;
  v_event private.nearby_match_events%rowtype;
  v_queue_count integer := 0;
begin
  select *
  into v_match
  from private.match_plate_alert_v2_internal(p_plate)
  limit 1;

  if not found then
    return;
  end if;

  if p_installation_id is null
    or p_latitude is null or p_latitude not between -90 and 90
    or p_longitude is null or p_longitude not between -180 and 180
    or p_accuracy_meters is null or p_accuracy_meters not between 0 and 10000
    or not exists (
      select 1
      from private.nearby_devices as sender_device
      where sender_device.user_id = v_user_id
        and sender_device.installation_id = p_installation_id
        and sender_device.notifications_enabled = true
    )
  then
    return query
      select
        v_match.id,
        v_match.plate,
        v_match.description,
        v_match.created_at,
        v_match.expires_at,
        v_match.reporter_name,
        null::uuid,
        null::timestamptz,
        false;
    return;
  end if;

  update private.nearby_devices as sender_device
  set
    last_latitude = p_latitude,
    last_longitude = p_longitude,
    location_accuracy_meters = p_accuracy_meters,
    location_updated_at = now(),
    updated_at = now()
  where sender_device.user_id = v_user_id
    and sender_device.installation_id = p_installation_id;

  delete from private.nearby_match_events as expired_event
  where expired_event.expires_at <= now();

  select event.*
  into v_existing_event
  from private.nearby_match_events as event
  where event.alert_id = v_match.id
    and event.observed_at >= now() - interval '15 minutes'
    and private.distance_meters(
      event.exact_latitude,
      event.exact_longitude,
      p_latitude,
      p_longitude
    ) <= 250
  order by event.observed_at desc
  limit 1;

  if found then
    return query
      select
        v_match.id,
        v_match.plate,
        v_match.description,
        v_match.created_at,
        v_match.expires_at,
        v_match.reporter_name,
        v_existing_event.id,
        v_existing_event.observed_at,
        false;
    return;
  end if;

  insert into private.nearby_match_events (
    alert_id,
    plate,
    matched_by,
    exact_latitude,
    exact_longitude,
    location_accuracy_meters
  )
  values (
    v_match.id,
    v_match.plate,
    v_user_id,
    p_latitude,
    p_longitude,
    p_accuracy_meters
  )
  returning * into v_event;

  insert into private.nearby_notification_queue (
    event_id,
    recipient_user_id,
    recipient_installation_id,
    push_token,
    distance_meters
  )
  select
    v_event.id,
    recipient.user_id,
    recipient.installation_id,
    recipient.push_token,
    pg_catalog.round(distance.value)::integer
  from private.nearby_devices as recipient
  join private.account_moderation as moderation
    on moderation.user_id = recipient.user_id
  cross join lateral (
    select private.distance_meters(
      v_event.exact_latitude,
      v_event.exact_longitude,
      recipient.last_latitude,
      recipient.last_longitude
    ) as value
  ) as distance
  where recipient.notifications_enabled = true
    and recipient.push_token is not null
    and recipient.last_latitude is not null
    and recipient.last_longitude is not null
    and recipient.location_updated_at >= now() - interval '30 minutes'
    and recipient.user_id <> v_user_id
    and moderation.status = 'active'
    and distance.value <= 5000
  on conflict (event_id, recipient_user_id, recipient_installation_id) do nothing;

  get diagnostics v_queue_count = row_count;

  return query
    select
      v_match.id,
      v_match.plate,
      v_match.description,
      v_match.created_at,
      v_match.expires_at,
      v_match.reporter_name,
      v_event.id,
      v_event.observed_at,
      v_queue_count > 0;
end;
$$;

revoke all on function private.match_plate_alert_v3_internal(
  text,
  uuid,
  double precision,
  double precision,
  double precision
) from public, anon, authenticated;
grant execute on function private.match_plate_alert_v3_internal(
  text,
  uuid,
  double precision,
  double precision,
  double precision
) to authenticated;

create or replace function private.claim_nearby_notification_batch_internal(
  p_event_id uuid,
  p_requesting_user_id uuid,
  p_limit integer default 100
)
returns table (
  queue_id uuid,
  push_token text,
  plate text,
  description text,
  observed_at timestamptz,
  distance_meters integer,
  approximate_latitude numeric,
  approximate_longitude numeric
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_event_id is null or p_requesting_user_id is null or not exists (
    select 1
    from private.nearby_match_events as event
    where event.id = p_event_id
      and event.matched_by = p_requesting_user_id
      and event.expires_at > now()
  ) then
    raise exception 'EVENT_NOT_FOUND' using errcode = '42501';
  end if;

  return query
    with claimable as (
      select queue.id
      from private.nearby_notification_queue as queue
      where queue.event_id = p_event_id
        and (
          queue.status = 'queued'
          or (
            queue.status = 'processing'
            and queue.claimed_at < now() - interval '5 minutes'
          )
        )
        and queue.attempts < 5
      order by queue.created_at
      for update skip locked
      limit greatest(1, least(coalesce(p_limit, 100), 250))
    ),
    claimed as (
      update private.nearby_notification_queue as queue
      set
        status = 'processing',
        attempts = queue.attempts + 1,
        claimed_at = now(),
        last_error = null
      from claimable
      where queue.id = claimable.id
      returning
        queue.id,
        queue.event_id,
        queue.push_token,
        queue.distance_meters
    )
    select
      claimed.id,
      claimed.push_token,
      event.plate,
      alert.description,
      event.observed_at,
      claimed.distance_meters,
      pg_catalog.round(event.exact_latitude::numeric, 3),
      pg_catalog.round(event.exact_longitude::numeric, 3)
    from claimed
    join private.nearby_match_events as event on event.id = claimed.event_id
    join public.plate_alerts as alert on alert.id = event.alert_id;
end;
$$;

revoke all on function private.claim_nearby_notification_batch_internal(
  uuid,
  uuid,
  integer
) from public, anon, authenticated;
grant execute on function private.claim_nearby_notification_batch_internal(
  uuid,
  uuid,
  integer
) to service_role;

create or replace function private.complete_nearby_notification_internal(
  p_queue_id uuid,
  p_sent boolean,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.nearby_notification_queue as queue
  set
    status = case when coalesce(p_sent, false) then 'sent' else 'failed' end,
    sent_at = case when coalesce(p_sent, false) then now() else null end,
    last_error = case
      when coalesce(p_sent, false) then null
      else pg_catalog.left(coalesce(p_error, 'Ukendt push-fejl'), 500)
    end
  where queue.id = p_queue_id
    and queue.status = 'processing';
end;
$$;

revoke all on function private.complete_nearby_notification_internal(
  uuid,
  boolean,
  text
) from public, anon, authenticated;
grant execute on function private.complete_nearby_notification_internal(
  uuid,
  boolean,
  text
) to service_role;

create or replace function private.admin_list_users_internal(
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
  total_count bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller_id uuid := auth.uid();
  v_caller_role text;
  v_search text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_search, '')));
  v_status text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_status, 'all')));
begin
  select user_role.role
  into v_caller_role
  from private.user_roles as user_role
  where user_role.user_id = v_caller_id;

  if v_caller_role not in ('admin', 'creator') then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  if v_status not in ('all', 'active', 'suspended') then
    raise exception 'INVALID_STATUS' using errcode = '22023';
  end if;

  return query
    select
      auth_user.id,
      auth_user.email::text,
      profile.username,
      user_role.role,
      moderation.status,
      profile.hide_from_peers,
      auth_user.created_at,
      auth_user.last_sign_in_at,
      profile.last_active_at,
      (auth_user.email is null),
      pg_catalog.count(*) over()
    from auth.users as auth_user
    join public.user_profiles as profile on profile.user_id = auth_user.id
    join private.user_roles as user_role on user_role.user_id = auth_user.id
    join private.account_moderation as moderation on moderation.user_id = auth_user.id
    where
      (v_status = 'all' or moderation.status = v_status)
      and (
        v_search = ''
        or pg_catalog.lower(coalesce(profile.username, '')) like '%' || v_search || '%'
        or pg_catalog.lower(coalesce(auth_user.email, '')) like '%' || v_search || '%'
        or pg_catalog.lower(auth_user.id::text) like '%' || v_search || '%'
      )
    order by profile.last_active_at desc, auth_user.created_at desc
    limit greatest(1, least(coalesce(p_limit, 50), 100))
    offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

revoke all on function private.admin_list_users_internal(text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function private.admin_list_users_internal(text, text, integer, integer)
  to authenticated;

create or replace function private.admin_set_user_status_internal(
  p_user_id uuid,
  p_status text,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller_id uuid := auth.uid();
  v_caller_role text;
  v_target_role text;
  v_status text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_status, '')));
begin
  select user_role.role into v_caller_role
  from private.user_roles as user_role
  where user_role.user_id = v_caller_id;

  select user_role.role into v_target_role
  from private.user_roles as user_role
  where user_role.user_id = p_user_id;

  if v_caller_role not in ('admin', 'creator') then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  if v_status not in ('active', 'suspended') then
    raise exception 'INVALID_STATUS' using errcode = '22023';
  end if;

  if p_user_id is null or v_target_role is null then
    raise exception 'USER_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_user_id = v_caller_id or v_target_role = 'creator' then
    raise exception 'PROTECTED_ACCOUNT' using errcode = '42501';
  end if;

  if v_caller_role = 'admin' and v_target_role <> 'user' then
    raise exception 'CREATOR_REQUIRED' using errcode = '42501';
  end if;

  update private.account_moderation
  set
    status = v_status,
    reason = nullif(pg_catalog.btrim(coalesce(p_reason, '')), ''),
    updated_by = v_caller_id,
    updated_at = now()
  where user_id = p_user_id;
end;
$$;

revoke all on function private.admin_set_user_status_internal(uuid, text, text)
  from public, anon, authenticated;
grant execute on function private.admin_set_user_status_internal(uuid, text, text)
  to authenticated;

create or replace function private.admin_set_user_role_internal(
  p_user_id uuid,
  p_role text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller_id uuid := auth.uid();
  v_caller_role text;
  v_target_role text;
  v_role text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_role, '')));
begin
  select user_role.role into v_caller_role
  from private.user_roles as user_role
  where user_role.user_id = v_caller_id;

  select user_role.role into v_target_role
  from private.user_roles as user_role
  where user_role.user_id = p_user_id;

  if v_caller_role <> 'creator' then
    raise exception 'CREATOR_REQUIRED' using errcode = '42501';
  end if;

  if v_role not in ('user', 'admin') then
    raise exception 'INVALID_ROLE' using errcode = '22023';
  end if;

  if p_user_id is null or v_target_role is null then
    raise exception 'USER_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_user_id = v_caller_id or v_target_role = 'creator' then
    raise exception 'PROTECTED_ACCOUNT' using errcode = '42501';
  end if;

  update private.user_roles
  set role = v_role, updated_at = now()
  where user_id = p_user_id;
end;
$$;

revoke all on function private.admin_set_user_role_internal(uuid, text)
  from public, anon, authenticated;
grant execute on function private.admin_set_user_role_internal(uuid, text)
  to authenticated;

create or replace function public.get_my_profile()
returns table (
  user_id uuid,
  email text,
  username text,
  hide_from_peers boolean,
  role text,
  account_status text,
  created_at timestamptz,
  last_active_at timestamptz,
  is_anonymous boolean
)
language sql
security invoker
set search_path = ''
as $$
  select * from private.get_my_profile_internal();
$$;

revoke all on function public.get_my_profile()
  from public, anon, authenticated;
grant execute on function public.get_my_profile()
  to authenticated;

create or replace function public.save_my_profile(
  p_username text,
  p_hide_from_peers boolean
)
returns table (
  user_id uuid,
  email text,
  username text,
  hide_from_peers boolean,
  role text,
  account_status text,
  created_at timestamptz,
  last_active_at timestamptz,
  is_anonymous boolean
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from private.save_my_profile_internal(p_username, p_hide_from_peers);
$$;

revoke all on function public.save_my_profile(text, boolean)
  from public, anon, authenticated;
grant execute on function public.save_my_profile(text, boolean)
  to authenticated;

create or replace function public.create_plate_alert(
  p_plate text,
  p_description text
)
returns table (
  id uuid,
  plate text,
  description text,
  created_at timestamptz,
  expires_at timestamptz,
  duplicate boolean
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from private.create_plate_alert_internal(p_plate, p_description);
$$;

revoke all on function public.create_plate_alert(text, text)
  from public, anon, authenticated;
grant execute on function public.create_plate_alert(text, text)
  to authenticated;

create or replace function public.match_plate_alert_v2(p_plate text)
returns table (
  id uuid,
  plate text,
  description text,
  created_at timestamptz,
  expires_at timestamptz,
  reporter_name text
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from private.match_plate_alert_v2_internal(p_plate);
$$;

revoke all on function public.match_plate_alert_v2(text)
  from public, anon, authenticated;
grant execute on function public.match_plate_alert_v2(text)
  to authenticated;

create or replace function public.set_nearby_device(
  p_installation_id uuid,
  p_push_token text,
  p_enabled boolean,
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy_meters double precision
)
returns table (
  enabled boolean,
  location_updated_at timestamptz
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from private.set_nearby_device_internal(
    p_installation_id,
    p_push_token,
    p_enabled,
    p_latitude,
    p_longitude,
    p_accuracy_meters
  );
$$;

revoke all on function public.set_nearby_device(
  uuid,
  text,
  boolean,
  double precision,
  double precision,
  double precision
) from public, anon, authenticated;
grant execute on function public.set_nearby_device(
  uuid,
  text,
  boolean,
  double precision,
  double precision,
  double precision
) to authenticated;

create or replace function public.get_nearby_device(
  p_installation_id uuid
)
returns table (
  enabled boolean,
  location_updated_at timestamptz
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from private.get_nearby_device_internal(p_installation_id);
$$;

revoke all on function public.get_nearby_device(uuid)
  from public, anon, authenticated;
grant execute on function public.get_nearby_device(uuid)
  to authenticated;

create or replace function public.match_plate_alert_v3(
  p_plate text,
  p_installation_id uuid,
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy_meters double precision
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
  notifications_queued boolean
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from private.match_plate_alert_v3_internal(
    p_plate,
    p_installation_id,
    p_latitude,
    p_longitude,
    p_accuracy_meters
  );
$$;

revoke all on function public.match_plate_alert_v3(
  text,
  uuid,
  double precision,
  double precision,
  double precision
) from public, anon, authenticated;
grant execute on function public.match_plate_alert_v3(
  text,
  uuid,
  double precision,
  double precision,
  double precision
) to authenticated;

create or replace function public.claim_nearby_notification_batch(
  p_event_id uuid,
  p_requesting_user_id uuid,
  p_limit integer default 100
)
returns table (
  queue_id uuid,
  push_token text,
  plate text,
  description text,
  observed_at timestamptz,
  distance_meters integer,
  approximate_latitude numeric,
  approximate_longitude numeric
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from private.claim_nearby_notification_batch_internal(
    p_event_id,
    p_requesting_user_id,
    p_limit
  );
$$;

revoke all on function public.claim_nearby_notification_batch(
  uuid,
  uuid,
  integer
) from public, anon, authenticated;
grant execute on function public.claim_nearby_notification_batch(
  uuid,
  uuid,
  integer
) to service_role;

create or replace function public.complete_nearby_notification(
  p_queue_id uuid,
  p_sent boolean,
  p_error text default null
)
returns void
language sql
security invoker
set search_path = ''
as $$
  select private.complete_nearby_notification_internal(
    p_queue_id,
    p_sent,
    p_error
  );
$$;

revoke all on function public.complete_nearby_notification(
  uuid,
  boolean,
  text
) from public, anon, authenticated;
grant execute on function public.complete_nearby_notification(
  uuid,
  boolean,
  text
) to service_role;

create or replace function public.admin_list_users(
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
  total_count bigint
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from private.admin_list_users_internal(p_search, p_status, p_limit, p_offset);
$$;

revoke all on function public.admin_list_users(text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.admin_list_users(text, text, integer, integer)
  to authenticated;

create or replace function public.admin_set_user_status(
  p_user_id uuid,
  p_status text,
  p_reason text default null
)
returns void
language sql
security invoker
set search_path = ''
as $$
  select private.admin_set_user_status_internal(p_user_id, p_status, p_reason);
$$;

revoke all on function public.admin_set_user_status(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.admin_set_user_status(uuid, text, text)
  to authenticated;

create or replace function public.admin_set_user_role(
  p_user_id uuid,
  p_role text
)
returns void
language sql
security invoker
set search_path = ''
as $$
  select private.admin_set_user_role_internal(p_user_id, p_role);
$$;

revoke all on function public.admin_set_user_role(uuid, text)
  from public, anon, authenticated;
grant execute on function public.admin_set_user_role(uuid, text)
  to authenticated;

comment on table public.user_profiles is
  'Private-by-default Pladetjek-profiler. Klienter har ingen direkte tabeladgang.';

comment on table public.plate_alerts is
  'Matchbaserede Pladetjek-advarsler. Ingen klientrolle kan læse tabellen direkte.';

comment on function public.get_my_profile() is
  'Returnerer kun den aktuelle brugers egen konto og beskyttede rolle.';

comment on function public.admin_list_users(text, text, integer, integer) is
  'Beskyttet brugeroversigt med e-mail og internt id for creator/admin.';

comment on function public.create_plate_alert(text, text) is
  'Opretter en tidsbegrænset advarsel med dublet-, status- og ratekontrol.';

comment on function public.match_plate_alert_v2(text) is
  'Returnerer højst ét aktivt match samt kun det tilladte offentlige afsendernavn.';

commit;
