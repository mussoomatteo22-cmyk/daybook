-- Daybook classes (lecture/lab times, assignments, tests). Run after 001_daybook.sql.
create table if not exists public.classes (
  id         text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade default auth.uid(),
  data       jsonb not null,
  updated_at timestamptz not null default now()
);
create index if not exists classes_user_idx on public.classes(user_id);
alter table public.classes enable row level security;
drop policy if exists "own rows" on public.classes;
create policy "own rows" on public.classes for all using (user_id = auth.uid()) with check (user_id = auth.uid());
drop trigger if exists classes_touch on public.classes;
create trigger classes_touch before update on public.classes for each row execute function public.touch_updated_at();
alter publication supabase_realtime add table public.classes;
