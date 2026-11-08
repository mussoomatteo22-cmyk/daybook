-- Run AFTER deploying the send-reminders function. Replace the two placeholders.
-- Calls the function every 5 minutes.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'daybook-reminders',
  '*/5 * * * *',
  $$
  select net.http_post(
    url     := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/send-reminders',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','YOUR-CRON-SECRET'),
    body    := '{}'::jsonb
  );
  $$
);
-- To stop it later: select cron.unschedule('daybook-reminders');
