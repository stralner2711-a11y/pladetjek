begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

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
    check (char_length(description) between 5 and 240),
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
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
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

  select count(*)::integer
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

create or replace function private.match_plate_alert_internal(p_plate text)
returns table (
  id uuid,
  plate text,
  description text,
  created_at timestamptz,
  expires_at timestamptz
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
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
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

  return query
    select
      alert.id,
      alert.plate,
      alert.description,
      alert.created_at,
      alert.expires_at
    from public.plate_alerts as alert
    where alert.plate = v_plate
      and alert.expires_at > now()
    order by alert.created_at desc
    limit 1;
end;
$$;

revoke all on function private.match_plate_alert_internal(text)
  from public, anon, authenticated;
grant execute on function private.match_plate_alert_internal(text)
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

create or replace function public.match_plate_alert(p_plate text)
returns table (
  id uuid,
  plate text,
  description text,
  created_at timestamptz,
  expires_at timestamptz
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from private.match_plate_alert_internal(p_plate);
$$;

revoke all on function public.match_plate_alert(text)
  from public, anon, authenticated;
grant execute on function public.match_plate_alert(text)
  to authenticated;

comment on table public.plate_alerts is
  'Matchbaserede Pladetjek-advarsler. Ingen klientrolle kan læse tabellen direkte.';

comment on function public.create_plate_alert(text, text) is
  'Opretter en tidsbegrænset advarsel med dublet- og ratekontrol.';

comment on function public.match_plate_alert(text) is
  'Returnerer højst ét aktivt match for den præcise scannede nummerplade.';

commit;
