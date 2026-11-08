-- Daybook schema. Run once in Supabase → SQL Editor (or `supabase db push`).
-- Every row belongs to one signed-in person; row-level security keeps it private.

create table if not exists public.events (
  id         text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade default auth.uid(),
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.projects (
  id         text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade default auth.uid(),
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.settings (
  user_id    uuid primary key references auth.users(id) on delete cascade default auth.uid(),
  email      text,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

-- Remembers which emails were already sent so a reminder never goes out twice.
create table if not exists public.reminder_log (
  key     text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  sent_at timestamptz not null default now()
);

create index if not exists events_user_idx on public.events(user_id);
create index if not exists projects_user_idx on public.projects(user_id);

alter table public.events       enable row level security;
alter table public.projects     enable row level security;
alter table public.settings     enable row level security;
alter table public.reminder_log enable row level security;  -- no policies: only the server function touches it

do $$
declare t text;
begin
  foreach t in array array['events','projects','settings'] loop
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format($p$create policy "own rows" on public.%I for all
                     using (user_id = auth.uid()) with check (user_id = auth.uid())$p$, t);
  end loop;
end $$;

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists events_touch on public.events;
create trigger events_touch before update on public.events for each row execute function public.touch_updated_at();
drop trigger if exists projects_touch on public.projects;
create trigger projects_touch before update on public.projects for each row execute function public.touch_updated_at();
drop trigger if exists settings_touch on public.settings;
create trigger settings_touch before update on public.settings for each row execute function public.touch_updated_at();

-- Live sync between your phone and computer.
alter publication supabase_realtime add table public.events, public.projects, public.settings;

-- Clean up old reminder log rows weekly-ish (called by the reminder function).
create or replace function public.prune_reminder_log() returns void language sql security definer as $$
  delete from public.reminder_log where sent_at < now() - interval '14 days';
$$;
