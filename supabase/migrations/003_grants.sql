-- Make sure signed-in people can reach their own rows through the API (row-level security still
-- limits them to their own), and that signed-out visitors can't reach anything.
grant select, insert, update, delete on public.events, public.projects, public.settings, public.classes to authenticated;
revoke all on public.events, public.projects, public.settings, public.classes, public.reminder_log from anon;
revoke all on public.reminder_log from authenticated;
