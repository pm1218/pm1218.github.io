-- =====================================================================
-- Mario Kart Wii GP Tracker — Supabase / PostgreSQL schema
-- Run once in the Supabase SQL editor (Dashboard → SQL → New query).
-- Safe to re-run: every object is created idempotently.
-- =====================================================================

create extension if not exists citext;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------

-- Mario Kart Wii 12-player points, indexed by finishing position.
create or replace function public.mkw_points(p_place int)
returns int language sql immutable as $$
  select (array[15,12,10,8,7,6,5,4,3,2,1,0])[p_place]
$$;

create or replace function public.mkw_characters()
returns text[] language sql immutable as $$
  select array[
    'Baby Mario','Baby Luigi','Baby Peach','Baby Daisy','Toad','Toadette',
    'Koopa Troopa','Dry Bones','Mario','Luigi','Peach','Daisy','Yoshi',
    'Birdo','Diddy Kong','Bowser Jr.','Wario','Waluigi','Donkey Kong',
    'Bowser','King Boo','Rosalina','Funky Kong','Dry Bowser','Mii'
  ]
$$;

create or replace function public.mkw_cups()
returns text[] language sql immutable as $$
  select array['Mushroom','Flower','Star','Special','Shell','Banana','Leaf','Lightning']
$$;

-- ---------------------------------------------------------------------
-- Whitelist + profiles
-- ---------------------------------------------------------------------

create table if not exists public.approved_users (
  email      citext primary key check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  is_admin   boolean not null default false,
  added_by   uuid,
  added_at   timestamptz not null default now()
);

create table if not exists public.profiles (
  id                 uuid primary key references auth.users(id) on delete cascade,
  email              citext not null unique,
  display_name       text not null check (char_length(display_name) between 1 and 40),
  mii_name           text check (mii_name is null or char_length(mii_name) <= 20),
  favorite_character text check (favorite_character is null or favorite_character = any(public.mkw_characters())),
  created_at         timestamptz not null default now()
);

create or replace function public.current_email()
returns citext language sql stable as $$
  select nullif(auth.jwt() ->> 'email', '')::citext
$$;

create or replace function public.is_approved()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.approved_users where email = public.current_email())
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.approved_users where email = public.current_email() and is_admin)
$$;

-- Server-side whitelist gate: Supabase Auth inserts into auth.users the
-- first time an email requests a code. Unapproved emails are rejected
-- here, so no account (and no code e-mail) is ever created for them.
create or replace function public.enforce_whitelist()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.approved_users where email = new.email::citext) then
    raise exception 'email not approved' using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function public.create_profile()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, initcap(split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists mkw_enforce_whitelist on auth.users;
create trigger mkw_enforce_whitelist before insert on auth.users
  for each row execute function public.enforce_whitelist();

drop trigger if exists mkw_create_profile on auth.users;
create trigger mkw_create_profile after insert on auth.users
  for each row execute function public.create_profile();

-- Never let the group lose its last admin.
create or replace function public.keep_one_admin()
returns trigger language plpgsql as $$
begin
  if not exists (select 1 from public.approved_users where is_admin) then
    raise exception 'at least one admin must remain';
  end if;
  return null;
end $$;

drop trigger if exists mkw_keep_one_admin on public.approved_users;
create constraint trigger mkw_keep_one_admin after delete or update on public.approved_users
  deferrable initially deferred for each row execute function public.keep_one_admin();

-- ---------------------------------------------------------------------
-- Events → Grand Prix → Races → Results
-- ---------------------------------------------------------------------

create table if not exists public.events (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 120),
  kind        text not null default 'session' check (kind in ('weekend','trip','session','other')),
  location    text check (location is null or char_length(location) <= 120),
  starts_on   date,
  created_by  uuid not null default auth.uid() references public.profiles(id),
  created_at  timestamptz not null default now()
);

create table if not exists public.grand_prix (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid not null references public.events(id) on delete cascade,
  seq             int  not null check (seq >= 1),
  cup             text check (cup is null or cup = any(public.mkw_cups())),  -- unused for VS sessions (random tracks)
  engine_class    text not null default '150cc' check (engine_class in ('50cc','100cc','150cc','Mirror')),
  entry_mode      text check (entry_mode in ('total','races')),
  status          text not null default 'draft' check (status in ('draft','confirmed')),
  created_by      uuid not null default auth.uid() references public.profiles(id),
  confirmed_by    uuid references public.profiles(id),
  confirmed_at    timestamptz,
  summary_sent_at timestamptz,
  created_at      timestamptz not null default now(),
  unique (event_id, seq),
  check ((status = 'confirmed') = (entry_mode is not null and confirmed_at is not null))
);

-- One row per human kart in the session (members and guests). CPUs are not tracked.
create table if not exists public.gp_participants (
  id          uuid primary key default gen_random_uuid(),
  gp_id       uuid not null references public.grand_prix(id) on delete cascade,
  profile_id  uuid references public.profiles(id),
  label       text not null check (char_length(label) between 1 and 40),
  character   text check (character is null or character = any(public.mkw_characters())),
  is_cpu      boolean not null default false,
  final_total int  not null check (final_total between 0 and 60),
  final_place int  not null check (final_place between 1 and 12),
  check (not (is_cpu and profile_id is not null))
);
create unique index if not exists gp_participants_one_profile
  on public.gp_participants (gp_id, profile_id) where profile_id is not null;

create table if not exists public.races (
  id          uuid primary key default gen_random_uuid(),
  gp_id       uuid not null references public.grand_prix(id) on delete cascade,
  race_number int  not null check (race_number between 1 and 4),
  track       text check (track is null or char_length(track) between 1 and 60),  -- optional: VS tracks are random
  unique (gp_id, race_number)
);

create table if not exists public.race_results (
  id             uuid primary key default gen_random_uuid(),
  race_id        uuid not null references public.races(id) on delete cascade,
  participant_id uuid not null references public.gp_participants(id) on delete cascade,
  placement      int  not null check (placement between 1 and 12),
  points         int  not null check (points between 0 and 15),
  unique (race_id, participant_id),
  unique (race_id, placement),
  check (points = public.mkw_points(placement))
);

create table if not exists public.score_uploads (
  id          uuid primary key default gen_random_uuid(),
  gp_id       uuid not null references public.grand_prix(id) on delete cascade,
  uploaded_by uuid not null references public.profiles(id),
  source      text not null check (source in ('manual_total','manual_races','photo_total','photo_races')),
  image_paths text[] not null default '{}',
  ocr_raw     jsonb,
  created_at  timestamptz not null default now()
);

-- Character icons cropped from confirmed photos; the group's own
-- template library for OpenCV template matching.
create table if not exists public.icon_templates (
  id          uuid primary key default gen_random_uuid(),
  character   text not null check (character = any(public.mkw_characters())),
  image_path  text not null unique,
  created_by  uuid not null default auth.uid() references public.profiles(id),
  created_at  timestamptz not null default now()
);

-- Events: live until finalized (by hand, or automatically after 12 h without uploads).
alter table public.events add column if not exists finalized_at timestamptz;
alter table public.events add column if not exists recap_sent_at timestamptz;

-- VS mode (safe to re-run on an existing database)
alter table public.grand_prix alter column cup drop not null;
alter table public.races alter column track drop not null;
alter table public.races drop constraint if exists races_track_check;
alter table public.races add constraint races_track_check check (track is null or char_length(track) between 1 and 60);

create index if not exists grand_prix_event_idx on public.grand_prix(event_id);
create index if not exists gp_participants_gp_idx on public.gp_participants(gp_id);
create index if not exists races_gp_idx on public.races(gp_id);
create index if not exists race_results_race_idx on public.race_results(race_id);

-- Next GP number inside an event.
create or replace function public.set_gp_seq()
returns trigger language plpgsql as $$
begin
  if new.seq is null then
    select coalesce(max(seq), 0) + 1 into new.seq from public.grand_prix where event_id = new.event_id;
  end if;
  return new;
end $$;
drop trigger if exists mkw_set_gp_seq on public.grand_prix;
create trigger mkw_set_gp_seq before insert on public.grand_prix
  for each row execute function public.set_gp_seq();

-- ---------------------------------------------------------------------
-- Event lifecycle
-- ---------------------------------------------------------------------
create or replace function public.is_service_role()
returns boolean language sql stable as $$
  select coalesce(auth.jwt() ->> 'role', '') = 'service_role'
$$;

-- Last upload activity: event creation, a session started, or scores confirmed.
create or replace function public.event_last_activity(p_event_id uuid)
returns timestamptz language sql stable security definer set search_path = public as $$
  select greatest(e.created_at, max(g.created_at), max(g.confirmed_at))
    from public.events e left join public.grand_prix g on g.event_id = e.id
   where e.id = p_event_id
   group by e.created_at
$$;

create or replace function public.event_is_over(p_event_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select e.finalized_at is not null or public.event_last_activity(e.id) < now() - interval '12 hours'
    from public.events e where e.id = p_event_id
$$;

-- Marks every event idle for 12 h as finalized (at last activity + 12 h).
-- Called by the app on load and by the mailer on every run.
create or replace function public.finalize_stale_events()
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not (public.is_approved() or public.is_service_role()) then
    raise exception 'not approved' using errcode = '42501';
  end if;
  update public.events e
     set finalized_at = public.event_last_activity(e.id) + interval '12 hours'
   where e.finalized_at is null
     and public.event_last_activity(e.id) < now() - interval '12 hours';
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.finalize_event(p_event_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_approved() then raise exception 'not approved' using errcode = '42501'; end if;
  if not exists (select 1 from public.events where id = p_event_id and (created_by = auth.uid() or public.is_admin())) then
    raise exception 'only the event creator or an admin can finalize it' using errcode = '42501';
  end if;
  update public.events set finalized_at = now() where id = p_event_id and finalized_at is null;
end $$;

create or replace function public.reopen_event(p_event_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'admins only' using errcode = '42501'; end if;
  update public.events set finalized_at = null, recap_sent_at = null where id = p_event_id;
end $$;

revoke all on function public.finalize_stale_events() from public, anon;
grant execute on function public.finalize_stale_events() to authenticated, service_role;
revoke all on function public.finalize_event(uuid) from public, anon;
grant execute on function public.finalize_event(uuid) to authenticated;
revoke all on function public.reopen_event(uuid) from public, anon;
grant execute on function public.reopen_event(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- The ONLY write path for scores. Validates and confirms atomically.
--
-- p_payload = {
--   "mode": "total" | "races",
--   "source": "manual_total" | "manual_races" | "photo_total" | "photo_races",
--   "participants": [ { "key": "p1", "profile_id": uuid|null, "label": text,
--                       "character": text|null, "is_cpu": bool,
--                       "final_total": int (total mode only) } ],
--   "races": [ { "race_number": 1..4, "track": text,
--                "results": [ { "key": "p1", "placement": 1..12 } ] } ],
--   "image_paths": [text], "ocr_raw": jsonb
-- }
-- Points are always recomputed here from placements; client points are
-- never trusted.
-- ---------------------------------------------------------------------
create or replace function public.submit_grand_prix(p_gp_id uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_gp        public.grand_prix;
  v_mode      text := p_payload ->> 'mode';
  v_source    text := coalesce(p_payload ->> 'source', case when v_mode = 'races' then 'manual_races' else 'manual_total' end);
  v_parts     jsonb := coalesce(p_payload -> 'participants', '[]'::jsonb);
  v_races     jsonb := coalesce(p_payload -> 'races', '[]'::jsonb);
  v_n         int;
  v_part      jsonb;
  v_race      jsonb;
  v_res       jsonb;
  v_keys      text[];
  v_race_id   uuid;
  v_part_id   uuid;
  v_map       jsonb := '{}'::jsonb;
  v_totals    jsonb := '{}'::jsonb;
  v_key       text;
  v_total     int;
  v_cnt       int;
begin
  if not public.is_approved() then
    raise exception 'not approved' using errcode = '42501';
  end if;

  select * into v_gp from public.grand_prix where id = p_gp_id for update;
  if not found then raise exception 'grand prix not found'; end if;
  if v_gp.status = 'confirmed' then raise exception 'this session is already confirmed'; end if;
  if public.event_is_over(v_gp.event_id) then
    raise exception 'this event is finalized — no more uploads (an admin can reopen it)';
  end if;

  if v_mode not in ('total','races') then
    raise exception 'mode must be "total" or "races"';
  end if;
  if v_source not in ('manual_total','manual_races','photo_total','photo_races')
     or (v_mode = 'total' and v_source not in ('manual_total','photo_total'))
     or (v_mode = 'races' and v_source not in ('manual_races','photo_races')) then
    raise exception 'source % does not match mode %', v_source, v_mode;
  end if;

  -- Participants -----------------------------------------------------
  v_n := jsonb_array_length(v_parts);
  if v_n < 2 or v_n > 12 then
    raise exception 'a session needs between 2 and 12 players (got %)', v_n;
  end if;

  select array_agg(e ->> 'key') into v_keys from jsonb_array_elements(v_parts) e;
  if (select count(distinct k) from unnest(v_keys) k where k is not null and k <> '') <> v_n then
    raise exception 'every participant needs a unique key';
  end if;

  if (select count(*) from jsonb_array_elements(v_parts) e where nullif(e ->> 'profile_id','') is not null)
     <> (select count(distinct e ->> 'profile_id') from jsonb_array_elements(v_parts) e where nullif(e ->> 'profile_id','') is not null) then
    raise exception 'the same player is mapped to two karts';
  end if;
  if not exists (select 1 from jsonb_array_elements(v_parts) e where nullif(e ->> 'profile_id','') is not null) then
    raise exception 'map at least one kart to a group member';
  end if;
  if exists (select 1 from jsonb_array_elements(v_parts) e where coalesce((e ->> 'is_cpu')::boolean, false)) then
    raise exception 'CPU players are not tracked — remove them before confirming';
  end if;

  -- Mode-specific validation ------------------------------------------
  if v_mode = 'races' then
    -- The completeness rule: exactly four races, numbered 1-4.
    if jsonb_array_length(v_races) <> 4 then
      raise exception 'individual race mode requires all 4 races (got %). Upload the final total score instead.',
        jsonb_array_length(v_races) using errcode = '22023';
    end if;
    if (select array_agg((r ->> 'race_number')::int order by (r ->> 'race_number')::int)
          from jsonb_array_elements(v_races) r) <> array[1,2,3,4] then
      raise exception 'races must be numbered 1, 2, 3 and 4 exactly once' using errcode = '22023';
    end if;

    for v_race in select * from jsonb_array_elements(v_races) loop
      select count(*), count(distinct r ->> 'key'), count(distinct (r ->> 'placement')::int)
        into v_cnt, v_total, v_n
        from jsonb_array_elements(coalesce(v_race -> 'results', '[]'::jsonb)) r;
      if v_cnt <> jsonb_array_length(v_parts) or v_total <> v_cnt or v_n <> v_cnt then
        raise exception 'race % must list every participant exactly once with distinct placements',
          v_race ->> 'race_number' using errcode = '22023';
      end if;
      if exists (select 1 from jsonb_array_elements(v_race -> 'results') r
                  where not (r ->> 'key' = any(v_keys))
                     or (r ->> 'placement')::int not between 1 and 12) then
        raise exception 'race % has an unknown participant or a placement outside 1-12', v_race ->> 'race_number';
      end if;
    end loop;

    -- Compute the GP totals from the four placements.
    for v_key in select unnest(v_keys) loop
      select sum(public.mkw_points((r ->> 'placement')::int)) into v_total
        from jsonb_array_elements(v_races) race,
             jsonb_array_elements(race -> 'results') r
       where r ->> 'key' = v_key;
      v_totals := v_totals || jsonb_build_object(v_key, v_total);
    end loop;
  else
    -- Final totals may still record which tracks were played (no placements).
    if exists (select 1 from jsonb_array_elements(v_races) r
                where jsonb_array_length(coalesce(r -> 'results', '[]'::jsonb)) > 0) then
      raise exception 'final total mode must not include race placements';
    end if;
    if exists (select 1 from jsonb_array_elements(v_races) r
                where coalesce((r ->> 'race_number')::int, 0) not between 1 and 4
                   or coalesce(trim(r ->> 'track'), '') = '')
       or (select count(*) from jsonb_array_elements(v_races)) <>
          (select count(distinct (r ->> 'race_number')::int) from jsonb_array_elements(v_races) r) then
      raise exception 'tracks must be numbered 1-4, once each, with a track name';
    end if;
    for v_part in select * from jsonb_array_elements(v_parts) loop
      if (v_part ->> 'final_total') is null or (v_part ->> 'final_total') !~ '^\d+$'
         or (v_part ->> 'final_total')::int > 60 then
        raise exception 'final total for % must be a whole number from 0 to 60', v_part ->> 'label';
      end if;
      v_totals := v_totals || jsonb_build_object(v_part ->> 'key', (v_part ->> 'final_total')::int);
    end loop;
  end if;

  -- Write ------------------------------------------------------------
  delete from public.gp_participants where gp_id = p_gp_id;
  delete from public.races where gp_id = p_gp_id;

  for v_part in select * from jsonb_array_elements(v_parts) loop
    insert into public.gp_participants (gp_id, profile_id, label, character, is_cpu, final_total, final_place)
    values (
      p_gp_id,
      nullif(v_part ->> 'profile_id', '')::uuid,
      trim(v_part ->> 'label'),
      nullif(v_part ->> 'character', ''),
      coalesce((v_part ->> 'is_cpu')::boolean, false),
      (v_totals ->> (v_part ->> 'key'))::int,
      1  -- ranked below
    ) returning id into v_part_id;
    v_map := v_map || jsonb_build_object(v_part ->> 'key', v_part_id);
  end loop;

  -- Standard competition ranking: equal totals share a place.
  update public.gp_participants gp set final_place = ranked.rnk
    from (select id, rank() over (order by final_total desc) as rnk
            from public.gp_participants where gp_id = p_gp_id) ranked
   where gp.id = ranked.id;

  if v_mode = 'races' then
    for v_race in select * from jsonb_array_elements(v_races) loop
      insert into public.races (gp_id, race_number, track)
      values (p_gp_id, (v_race ->> 'race_number')::int, nullif(trim(coalesce(v_race ->> 'track', '')), ''))
      returning id into v_race_id;
      for v_res in select * from jsonb_array_elements(v_race -> 'results') loop
        insert into public.race_results (race_id, participant_id, placement, points)
        values (v_race_id, (v_map ->> (v_res ->> 'key'))::uuid,
                (v_res ->> 'placement')::int, public.mkw_points((v_res ->> 'placement')::int));
      end loop;
    end loop;
  else
    for v_race in select * from jsonb_array_elements(v_races) loop
      insert into public.races (gp_id, race_number, track)
      values (p_gp_id, (v_race ->> 'race_number')::int, trim(v_race ->> 'track'));
    end loop;
  end if;

  insert into public.score_uploads (gp_id, uploaded_by, source, image_paths, ocr_raw)
  values (p_gp_id, auth.uid(), v_source,
          coalesce(array(select jsonb_array_elements_text(p_payload -> 'image_paths')), '{}'),
          p_payload -> 'ocr_raw');

  update public.grand_prix
     set status = 'confirmed', entry_mode = v_mode,
         confirmed_by = auth.uid(), confirmed_at = now()
   where id = p_gp_id;

  return jsonb_build_object('gp_id', p_gp_id, 'mode', v_mode, 'totals', v_totals);
end $$;

-- Admin: reopen a confirmed GP to correct it (keeps history in score_uploads).
create or replace function public.reopen_grand_prix(p_gp_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'admins only' using errcode = '42501'; end if;
  delete from public.gp_participants where gp_id = p_gp_id;
  delete from public.races where gp_id = p_gp_id;
  update public.grand_prix
     set status = 'draft', entry_mode = null, confirmed_by = null,
         confirmed_at = null, summary_sent_at = null
   where id = p_gp_id;
end $$;

revoke all on function public.submit_grand_prix(uuid, jsonb) from public, anon;
grant execute on function public.submit_grand_prix(uuid, jsonb) to authenticated;
revoke all on function public.reopen_grand_prix(uuid) from public, anon;
grant execute on function public.reopen_grand_prix(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------

alter table public.approved_users  enable row level security;
alter table public.profiles        enable row level security;
alter table public.events          enable row level security;
alter table public.grand_prix      enable row level security;
alter table public.gp_participants enable row level security;
alter table public.races           enable row level security;
alter table public.race_results    enable row level security;
alter table public.score_uploads   enable row level security;
alter table public.icon_templates  enable row level security;

do $$
declare t text;
begin
  -- Read access: any approved member can read the game data and profiles.
  -- (The member list is NOT in here: see "Whitelist" below.)
  foreach t in array array['profiles','events','grand_prix','gp_participants',
                           'races','race_results','score_uploads','icon_templates'] loop
    execute format('drop policy if exists mkw_read on public.%I', t);
    execute format('create policy mkw_read on public.%I for select to authenticated using (public.is_approved())', t);
  end loop;
end $$;

-- Whitelist: members see only their own row (to know whether they're an
-- admin); admins see and manage the whole list. Nobody else learns who
-- the members are or which emails they use.
drop policy if exists mkw_read on public.approved_users;
drop policy if exists mkw_self_read on public.approved_users;
create policy mkw_self_read on public.approved_users for select to authenticated
  using (email = public.current_email() or public.is_admin());
drop policy if exists mkw_admin_write on public.approved_users;
create policy mkw_admin_write on public.approved_users for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Profiles: members see each other's name and character, never the email.
-- Column privileges hide profiles.email from the browser entirely (the
-- mailer uses the service role, which keeps full access). Members can
-- change only their own name and character.
revoke select, insert, update, delete on public.profiles from anon, authenticated;
grant select (id, display_name, mii_name, favorite_character, created_at) on public.profiles to authenticated;
grant update (display_name, mii_name, favorite_character) on public.profiles to authenticated;
drop policy if exists mkw_own_profile on public.profiles;
create policy mkw_own_profile on public.profiles for update to authenticated
  using (id = auth.uid() and public.is_approved())
  with check (id = auth.uid());

-- Events: members create; creator or admin edits/deletes.
drop policy if exists mkw_event_insert on public.events;
create policy mkw_event_insert on public.events for insert to authenticated
  with check (public.is_approved() and created_by = auth.uid());
drop policy if exists mkw_event_modify on public.events;
create policy mkw_event_modify on public.events for update to authenticated
  using (public.is_approved() and (created_by = auth.uid() or public.is_admin()));
drop policy if exists mkw_event_delete on public.events;
create policy mkw_event_delete on public.events for delete to authenticated
  using (public.is_approved() and (created_by = auth.uid() or public.is_admin()));

-- Grand prix: members create drafts; drafts deletable by creator, any by admin.
-- Status changes only happen through submit_grand_prix/reopen_grand_prix.
drop policy if exists mkw_gp_insert on public.grand_prix;
create policy mkw_gp_insert on public.grand_prix for insert to authenticated
  with check (public.is_approved() and created_by = auth.uid() and status = 'draft'
              and not public.event_is_over(event_id));
drop policy if exists mkw_gp_delete on public.grand_prix;
create policy mkw_gp_delete on public.grand_prix for delete to authenticated
  using (public.is_approved() and ((created_by = auth.uid() and status = 'draft') or public.is_admin()));

-- Icon templates: members add, admins remove.
drop policy if exists mkw_icon_insert on public.icon_templates;
create policy mkw_icon_insert on public.icon_templates for insert to authenticated
  with check (public.is_approved() and created_by = auth.uid());
drop policy if exists mkw_icon_delete on public.icon_templates;
create policy mkw_icon_delete on public.icon_templates for delete to authenticated
  using (public.is_admin());

-- gp_participants / races / race_results / score_uploads have NO write
-- policies: the 4-race rule cannot be bypassed from the browser.

-- ---------------------------------------------------------------------
-- Private storage bucket for score photos and icon crops
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('score-photos', 'score-photos', false, 8388608, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

drop policy if exists mkw_photo_read on storage.objects;
create policy mkw_photo_read on storage.objects for select to authenticated
  using (bucket_id = 'score-photos' and public.is_approved());
drop policy if exists mkw_photo_insert on storage.objects;
create policy mkw_photo_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'score-photos' and public.is_approved());
drop policy if exists mkw_photo_delete on storage.objects;
create policy mkw_photo_delete on storage.objects for delete to authenticated
  using (bucket_id = 'score-photos' and public.is_admin());
