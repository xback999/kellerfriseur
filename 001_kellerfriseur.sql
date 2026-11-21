-- =====================================================================
-- Kellerfriseur – Datenbank-Setup (Migration 001)
-- =====================================================================
-- Was dieses Skript macht:
--   * Es legt NEUE Tabellen an, deren Namen alle mit "kf_" beginnen.
--   * Es verändert, löscht oder überschreibt KEINE bestehenden Tabellen.
--   * Läuft es ein zweites Mal, bricht es sofort mit einer Meldung ab.
--
-- Ausführen: Supabase > SQL Editor > New query > alles einfügen > Run.
-- =====================================================================

begin;

do $$
begin
  if to_regclass('public.kf_bookings') is not null
     or to_regclass('public.kf_admins') is not null then
    raise exception 'Die Kellerfriseur-Tabellen (kf_...) sind bereits vorhanden. Dieses Skript wurde schon einmal ausgefuehrt und wird abgebrochen, damit nichts ueberschrieben wird.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Tabellen
-- ---------------------------------------------------------------------

create table public.kf_settings (
  id                    smallint primary key default 1 check (id = 1),
  duration_minutes      integer not null default 60  check (duration_minutes between 5 and 720),
  booking_horizon_days  integer not null default 30  check (booking_horizon_days between 1 and 365),
  min_lead_minutes      integer not null default 0   check (min_lead_minutes between 0 and 10080),
  contact_email         text    not null default 'lcordella818@gmail.com' check (char_length(contact_email) between 3 and 254),
  business_name         text    not null default 'Kellerfriseur' check (char_length(business_name) between 1 and 80),
  updated_at            timestamptz not null default now()
);
insert into public.kf_settings default values;

create table public.kf_admins (
  id                  uuid primary key default gen_random_uuid(),
  email               text not null check (email = lower(email) and char_length(email) between 3 and 254),
  name                text not null check (char_length(name) between 1 and 100),
  role                text not null default 'admin' check (role in ('owner', 'admin')),
  password_hash       text,
  active              boolean not null default true,
  notify              boolean not null default true,
  invite_token_hash   text,
  invite_expires_at   timestamptz,
  failed_logins       integer not null default 0,
  locked_until        timestamptz,
  last_login_at       timestamptz,
  created_at          timestamptz not null default now()
);
create unique index kf_admins_email_key on public.kf_admins (email);
create unique index kf_admins_invite_key on public.kf_admins (invite_token_hash) where invite_token_hash is not null;

create table public.kf_sessions (
  id            uuid primary key default gen_random_uuid(),
  admin_id      uuid not null references public.kf_admins (id) on delete cascade,
  token_hash    text not null unique,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  expires_at    timestamptz not null
);
create index kf_sessions_admin_idx on public.kf_sessions (admin_id);

create table public.kf_bookings (
  id              uuid primary key,
  start_at        timestamptz not null,
  end_at          timestamptz not null,
  status          text not null check (status in ('requested', 'confirmed', 'declined', 'withdrawn', 'cancelled')),
  source          text not null check (source in ('online', 'manual')),
  customer_name   text not null check (char_length(customer_name) between 1 and 120),
  customer_email  text check (customer_email is null or char_length(customer_email) <= 254),
  customer_phone  text check (customer_phone is null or char_length(customer_phone) <= 40),
  customer_note   text check (customer_note is null or char_length(customer_note) <= 1000),
  internal_note   text check (internal_note is null or char_length(internal_note) <= 2000),
  token_salt      text not null,
  token_hash      text not null unique,
  cancelled_by    text check (cancelled_by is null or cancelled_by in ('customer', 'admin')),
  decided_at      timestamptz,
  decided_by      uuid references public.kf_admins (id) on delete set null,
  created_by      uuid references public.kf_admins (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint kf_bookings_time_order check (end_at > start_at),
  -- Der entscheidende Schutz gegen Doppelbuchungen:
  -- Zwei AKTIVE Termine (offen oder bestaetigt) duerfen sich nie ueberschneiden.
  -- '[)' = Ende exklusiv, damit 09:00-10:00 und 10:00-11:00 direkt hintereinander moeglich sind.
  constraint kf_bookings_no_overlap
    exclude using gist (tstzrange(start_at, end_at, '[)') with &&)
    where (status in ('requested', 'confirmed'))
);
create index kf_bookings_start_idx  on public.kf_bookings (start_at);
create index kf_bookings_status_idx on public.kf_bookings (status);
create index kf_bookings_email_idx  on public.kf_bookings (lower(customer_email));

create table public.kf_blocks (
  id          uuid primary key default gen_random_uuid(),
  start_at    timestamptz not null,
  end_at      timestamptz not null,
  reason      text check (reason is null or char_length(reason) <= 200),
  created_by  uuid references public.kf_admins (id) on delete set null,
  created_at  timestamptz not null default now(),
  constraint kf_blocks_time_order check (end_at > start_at)
);
create index kf_blocks_range_idx on public.kf_blocks (start_at, end_at);

create table public.kf_email_log (
  id           uuid primary key default gen_random_uuid(),
  booking_id   uuid references public.kf_bookings (id) on delete cascade,
  kind         text not null,
  to_email     text not null,
  status       text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts     integer not null default 0,
  last_error   text,
  provider_id  text,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz,
  updated_at   timestamptz not null default now()
);
create index kf_email_log_status_idx  on public.kf_email_log (status);
create index kf_email_log_created_idx on public.kf_email_log (created_at desc);

create table public.kf_rate_limits (
  key           text not null,
  window_start  timestamptz not null,
  hits          integer not null default 0,
  primary key (key, window_start)
);

-- updated_at automatisch pflegen
create function public.kf_touch_updated_at() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger kf_bookings_touch before update on public.kf_bookings
  for each row execute function public.kf_touch_updated_at();
create trigger kf_settings_touch before update on public.kf_settings
  for each row execute function public.kf_touch_updated_at();
create trigger kf_email_log_touch before update on public.kf_email_log
  for each row execute function public.kf_touch_updated_at();

-- ---------------------------------------------------------------------
-- Funktionen (laufen jeweils in EINER Transaktion)
-- Fehlercodes: KF001 Zeitraum belegt, KF002 Vergangenheit/Vorlauf,
--   KF003 zu weit in der Zukunft, KF004 ungueltige Startzeit,
--   KF005 Termin nicht mehr aktiv, KF006 Status hat sich geaendert,
--   KF007 Termin nicht mehr aenderbar, KF008 zu viele aktive Anfragen,
--   KF009 nicht gefunden, KF010 ungueltige Eingabe
-- ---------------------------------------------------------------------

-- Oeffentliche Online-Buchung. Die Dauer kommt immer aus den Einstellungen,
-- nie vom Kunden.
create function public.kf_create_booking(
  p_id uuid, p_name text, p_email text, p_phone text, p_note text,
  p_start timestamptz, p_salt text, p_token_hash text
) returns public.kf_bookings
language plpgsql set search_path = public, pg_temp as $$
declare
  s        public.kf_settings;
  v_end    timestamptz;
  v_active integer;
  v_row    public.kf_bookings;
begin
  -- Serialisiert alle Buchungs-/Sperrzeit-Schreibvorgaenge (kleiner Salon: unkritisch).
  perform pg_advisory_xact_lock(727001);
  select * into s from public.kf_settings where id = 1;

  if p_start <> date_trunc('minute', p_start)
     or (extract(epoch from p_start))::bigint % 900 <> 0 then
    raise exception 'bad_start' using errcode = 'KF004';
  end if;
  if p_start <= now() or p_start < now() + make_interval(mins => s.min_lead_minutes) then
    raise exception 'start_in_past' using errcode = 'KF002';
  end if;
  if (p_start at time zone 'Europe/Berlin')::date
       > (now() at time zone 'Europe/Berlin')::date + s.booking_horizon_days then
    raise exception 'beyond_horizon' using errcode = 'KF003';
  end if;

  v_end := p_start + make_interval(mins => s.duration_minutes);

  select count(*) into v_active from public.kf_bookings
   where lower(customer_email) = lower(p_email)
     and status in ('requested', 'confirmed') and end_at > now();
  if v_active >= 3 then
    raise exception 'too_many_requests' using errcode = 'KF008';
  end if;

  if exists (select 1 from public.kf_blocks b
              where tstzrange(b.start_at, b.end_at, '[)') && tstzrange(p_start, v_end, '[)')) then
    raise exception 'slot_unavailable' using errcode = 'KF001';
  end if;

  begin
    insert into public.kf_bookings
      (id, start_at, end_at, status, source, customer_name, customer_email,
       customer_phone, customer_note, token_salt, token_hash)
    values
      (p_id, p_start, v_end, 'requested', 'online', p_name, p_email,
       p_phone, p_note, p_salt, p_token_hash)
    returning * into v_row;
  exception when exclusion_violation then
    raise exception 'slot_unavailable' using errcode = 'KF001';
  end;

  return v_row;
end $$;

-- Manueller Termin durch einen Admin (beliebige Uhrzeit/Dauer, auch rueckwirkend).
create function public.kf_create_manual_booking(
  p_id uuid, p_name text, p_email text, p_phone text, p_note text, p_internal text,
  p_start timestamptz, p_end timestamptz, p_salt text, p_token_hash text, p_admin uuid
) returns public.kf_bookings
language plpgsql set search_path = public, pg_temp as $$
declare
  v_row public.kf_bookings;
begin
  perform pg_advisory_xact_lock(727001);
  if p_end <= p_start then
    raise exception 'invalid_time' using errcode = 'KF010';
  end if;
  begin
    insert into public.kf_bookings
      (id, start_at, end_at, status, source, customer_name, customer_email,
       customer_phone, customer_note, internal_note, token_salt, token_hash,
       created_by, decided_at, decided_by)
    values
      (p_id, p_start, p_end, 'confirmed', 'manual', p_name, p_email,
       p_phone, p_note, p_internal, p_salt, p_token_hash, p_admin, now(), p_admin)
    returning * into v_row;
  exception when exclusion_violation then
    raise exception 'slot_unavailable' using errcode = 'KF001';
  end;
  return v_row;
end $$;

-- Termin bearbeiten / verschieben.
create function public.kf_update_booking(
  p_id uuid, p_name text, p_email text, p_phone text, p_note text, p_internal text,
  p_start timestamptz, p_end timestamptz
) returns public.kf_bookings
language plpgsql set search_path = public, pg_temp as $$
declare
  v_old public.kf_bookings;
  v_row public.kf_bookings;
begin
  perform pg_advisory_xact_lock(727001);
  select * into v_old from public.kf_bookings where id = p_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'KF009';
  end if;
  if p_end <= p_start then
    raise exception 'invalid_time' using errcode = 'KF010';
  end if;
  if (p_start <> v_old.start_at or p_end <> v_old.end_at)
     and v_old.status not in ('requested', 'confirmed') then
    raise exception 'not_active' using errcode = 'KF005';
  end if;
  begin
    update public.kf_bookings
       set customer_name = p_name, customer_email = p_email, customer_phone = p_phone,
           customer_note = p_note, internal_note = p_internal,
           start_at = p_start, end_at = p_end
     where id = p_id
     returning * into v_row;
  exception when exclusion_violation then
    raise exception 'slot_unavailable' using errcode = 'KF001';
  end;
  return v_row;
end $$;

-- Statuswechsel: accept | decline | admin_cancel | customer_cancel
create function public.kf_transition(p_id uuid, p_action text, p_admin uuid)
returns public.kf_bookings
language plpgsql set search_path = public, pg_temp as $$
declare
  v_row public.kf_bookings;
  v_cur public.kf_bookings;
begin
  if p_action = 'accept' then
    update public.kf_bookings
       set status = 'confirmed', decided_at = now(), decided_by = p_admin
     where id = p_id and status = 'requested'
     returning * into v_row;
  elsif p_action = 'decline' then
    update public.kf_bookings
       set status = 'declined', decided_at = now(), decided_by = p_admin
     where id = p_id and status = 'requested'
     returning * into v_row;
  elsif p_action = 'admin_cancel' then
    update public.kf_bookings
       set status = 'cancelled', cancelled_by = 'admin', decided_at = now(), decided_by = p_admin
     where id = p_id and status = 'confirmed'
     returning * into v_row;
  elsif p_action = 'customer_cancel' then
    update public.kf_bookings
       set status = case status when 'requested' then 'withdrawn' else 'cancelled' end,
           cancelled_by = 'customer', decided_at = now()
     where id = p_id and status in ('requested', 'confirmed') and start_at > now()
     returning * into v_row;
  else
    raise exception 'bad_action' using errcode = 'KF010';
  end if;

  if v_row.id is null then
    select * into v_cur from public.kf_bookings where id = p_id;
    if v_cur.id is null then
      raise exception 'not_found' using errcode = 'KF009';
    end if;
    if p_action = 'customer_cancel' and v_cur.status in ('requested', 'confirmed') then
      raise exception 'not_changeable' using errcode = 'KF007';
    end if;
    raise exception 'state_changed' using errcode = 'KF006';
  end if;
  return v_row;
end $$;

-- Sperrzeit anlegen. Bestehende Termine werden NIE angetastet.
-- Gibt es Termine im Zeitraum, wird ohne p_ack nichts angelegt und die Liste zurueckgegeben.
create function public.kf_create_block(
  p_start timestamptz, p_end timestamptz, p_reason text, p_admin uuid, p_ack boolean
) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_conflicts jsonb;
  v_row       public.kf_blocks;
begin
  perform pg_advisory_xact_lock(727001);
  if p_end <= p_start then
    raise exception 'invalid_time' using errcode = 'KF010';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', b.id, 'name', b.customer_name, 'status', b.status,
           'start', (extract(epoch from b.start_at) * 1000)::bigint,
           'end',   (extract(epoch from b.end_at) * 1000)::bigint) order by b.start_at), '[]'::jsonb)
    into v_conflicts
    from public.kf_bookings b
   where b.status in ('requested', 'confirmed')
     and tstzrange(b.start_at, b.end_at, '[)') && tstzrange(p_start, p_end, '[)');

  if jsonb_array_length(v_conflicts) > 0 and not coalesce(p_ack, false) then
    return jsonb_build_object('created', false, 'conflicts', v_conflicts);
  end if;

  insert into public.kf_blocks (start_at, end_at, reason, created_by)
  values (p_start, p_end, p_reason, p_admin)
  returning * into v_row;
  return jsonb_build_object('created', true, 'block', to_jsonb(v_row), 'conflicts', v_conflicts);
end $$;

-- Oeffentliche Sicht: nur Einstellungen + belegte Zeitraeume (Millisekunden), keine Personendaten.
create function public.kf_public_state(p_from timestamptz, p_to timestamptz)
returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'durationMinutes', s.duration_minutes,
    'horizonDays',     s.booking_horizon_days,
    'minLeadMinutes',  s.min_lead_minutes,
    'busy', coalesce((
      select jsonb_agg(jsonb_build_array(a.s, a.e))
      from (
        select (extract(epoch from start_at) * 1000)::bigint as s,
               (extract(epoch from end_at) * 1000)::bigint as e
          from public.kf_bookings
         where status in ('requested', 'confirmed') and start_at < p_to and end_at > p_from
        union all
        select (extract(epoch from start_at) * 1000)::bigint,
               (extract(epoch from end_at) * 1000)::bigint
          from public.kf_blocks
         where start_at < p_to and end_at > p_from
      ) a
    ), '[]'::jsonb))
  from public.kf_settings s where s.id = 1
$$;

-- Rate-Limiting: true = erlaubt, false = Limit ueberschritten.
create function public.kf_rate_hit(p_key text, p_window_seconds integer, p_max integer)
returns boolean
language plpgsql set search_path = public, pg_temp as $$
declare
  v_window timestamptz;
  v_hits   integer;
begin
  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into public.kf_rate_limits (key, window_start, hits)
  values (p_key, v_window, 1)
  on conflict (key, window_start) do update set hits = public.kf_rate_limits.hits + 1
  returning hits into v_hits;
  if random() < 0.02 then
    delete from public.kf_rate_limits where window_start < now() - interval '2 days';
  end if;
  return v_hits <= p_max;
end $$;

-- Kundensuche (Name, E-Mail, Telefon) mit sicherem Escaping.
create function public.kf_search_bookings(p_q text)
returns setof public.kf_bookings
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_q      text := btrim(coalesce(p_q, ''));
  v_esc    text;
  v_digits text := regexp_replace(coalesce(p_q, ''), '\D', '', 'g');
  v_alt    text;
begin
  v_esc := replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_');
  v_alt := v_digits;
  if v_digits like '0049%' then v_alt := '0' || substr(v_digits, 5);
  elsif v_digits like '49%' then v_alt := '0' || substr(v_digits, 3);
  end if;
  return query
    select b.* from public.kf_bookings b
     where (char_length(v_q) >= 2 and (
              b.customer_name ilike '%' || v_esc || '%' escape '\'
           or coalesce(b.customer_email, '') ilike '%' || v_esc || '%' escape '\'))
        or (char_length(v_digits) >= 3 and (
              regexp_replace(coalesce(b.customer_phone, ''), '\D', '', 'g') like '%' || v_digits || '%'
           or regexp_replace(coalesce(b.customer_phone, ''), '\D', '', 'g') like '%' || v_alt || '%'))
     order by b.start_at desc
     limit 300;
end $$;

-- Admin-Sitzung pruefen (liefert null, wenn ungueltig) und gelegentlich verlaengern.
create function public.kf_session_lookup(p_hash text)
returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_res jsonb;
begin
  select jsonb_build_object(
           'sessionId', s.id,
           'admin', jsonb_build_object('id', a.id, 'email', a.email, 'name', a.name,
                                       'role', a.role, 'notify', a.notify))
    into v_res
    from public.kf_sessions s
    join public.kf_admins a on a.id = s.admin_id
   where s.token_hash = p_hash
     and s.expires_at > now()
     and s.created_at > now() - interval '7 days'
     and a.active;
  if v_res is not null then
    update public.kf_sessions
       set last_seen_at = now(),
           expires_at = least(now() + interval '12 hours', created_at + interval '7 days')
     where token_hash = p_hash and last_seen_at < now() - interval '5 minutes';
  end if;
  return v_res;
end $$;

create function public.kf_cleanup() returns void
language sql set search_path = public, pg_temp as $$
  delete from public.kf_sessions where expires_at < now();
  delete from public.kf_rate_limits where window_start < now() - interval '2 days';
$$;

-- Erster Hauptadministrator: wird im SQL-Editor aufgerufen (siehe Anleitung).
create function public.kf_bootstrap_owner(p_email text, p_name text default 'Inhaber')
returns text
language plpgsql set search_path = public, pg_temp as $$
declare
  v_token text;
begin
  if exists (select 1 from public.kf_admins where role = 'owner') then
    raise exception 'Es gibt bereits einen Hauptadministrator. Fuer einen neuen Einrichtungslink nutze: select public.kf_issue_invite(''email@beispiel.de'');';
  end if;
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into public.kf_admins (email, name, role, invite_token_hash, invite_expires_at)
  values (lower(btrim(p_email)), p_name, 'owner',
          encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), now() + interval '7 days');
  return '/admin/#setup=' || v_token;
end $$;

-- Neuer Einrichtungs-/Passwort-Zuruecksetzen-Link fuer ein bestehendes Admin-Konto.
create function public.kf_issue_invite(p_email text)
returns text
language plpgsql set search_path = public, pg_temp as $$
declare
  v_token text;
  v_id    uuid;
begin
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  update public.kf_admins
     set invite_token_hash = encode(sha256(convert_to(v_token, 'UTF8')), 'hex'),
         invite_expires_at = now() + interval '7 days'
   where email = lower(btrim(p_email))
   returning id into v_id;
  if v_id is null then
    raise exception 'Kein Admin mit dieser E-Mail-Adresse gefunden.';
  end if;
  return '/admin/#setup=' || v_token;
end $$;

-- ---------------------------------------------------------------------
-- Sicherheit: Row Level Security + Rechte
-- Niemand ausser dem Server (service_role / Netlify Functions) darf
-- diese Tabellen oder Funktionen ueber die oeffentliche API nutzen.
-- ---------------------------------------------------------------------

alter table public.kf_settings    enable row level security;
alter table public.kf_admins      enable row level security;
alter table public.kf_sessions    enable row level security;
alter table public.kf_bookings    enable row level security;
alter table public.kf_blocks      enable row level security;
alter table public.kf_email_log   enable row level security;
alter table public.kf_rate_limits enable row level security;
-- Absichtlich KEINE Policies: anon und authenticated sehen und aendern nichts.

revoke all on table
  public.kf_settings, public.kf_admins, public.kf_sessions, public.kf_bookings,
  public.kf_blocks, public.kf_email_log, public.kf_rate_limits
  from public, anon, authenticated;

grant select, insert, update, delete on table
  public.kf_settings, public.kf_admins, public.kf_sessions, public.kf_bookings,
  public.kf_blocks, public.kf_email_log, public.kf_rate_limits
  to service_role;

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'kf\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $$;

commit;

notify pgrst, 'reload schema';
