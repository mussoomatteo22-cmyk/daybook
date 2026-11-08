-- Runs the send-reminders function every 5 minutes. Run AFTER deploying the function.
-- The Bearer value is the project's public anon key (the same one in web/config.js).
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'daybook-reminders',
  '*/5 * * * *',
  $$
  select net.http_post(
    url     := 'https://fyawvzbqgbhdwymgetme.supabase.co/functions/v1/send-reminders',
    headers := jsonb_build_object('Content-Type', 'application/json',
                 'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ5YXd2emJxZ2JoZHd5bWdldG1lIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQxNjY5MTUsImV4cCI6MjEwOTc0MjkxNX0.gzlI1gKwt7E5o2xr-Ko1J-jpR7AtmWhmt5jQFVIbdZk'),
    body    := '{}'::jsonb
  );
  $$
);
-- To stop it later: select cron.unschedule('daybook-reminders');
