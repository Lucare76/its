-- Repeatable operational installation. Run as the database owner in SQL Editor.
-- The hourly job runs inside Postgres; Vercel Hobby remains a daily fallback.
-- No messages are deleted and no HTTP requests or credentials are stored.
create or replace function public.close_inactive_whatsapp_threads()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_now timestamptz := now();
  v_cutoff timestamptz := now() - interval '24 hours';
  v_scanned integer;
  v_closed integer;
begin
  with candidates as materialized (
    select t.id, t.tenant_id, t.last_message_at, t.updated_at
    from public.whatsapp_threads t
    where t.tenant_id is not null
      and t.status = 'open' and t.match_status = 'matched'
      and t.unread_count = 0
      and t.last_message_at < v_cutoff and t.updated_at < v_cutoff
    for update of t skip locked
  ), eligible as (
    select c.*
    from candidates c
    cross join lateral (
      select m.id, m.direction, m.status, m.timestamp, m.raw_message
      from public.whatsapp_messages m
      where m.tenant_id = c.tenant_id and m.thread_id = c.id
      order by m.timestamp desc nulls first, m.created_at desc
      limit 1
    ) last_msg
    where last_msg.direction = 'outbound'
      and last_msg.status in ('sent', 'delivered', 'read')
      and last_msg.timestamp < v_cutoff
      and last_msg.timestamp = c.last_message_at
      and coalesce(last_msg.raw_message->>'source', '') <> 'office_closed_auto_reply'
      and not exists (
        select 1 from public.whatsapp_messages tied
        where tied.tenant_id = c.tenant_id and tied.thread_id = c.id
          and tied.timestamp = last_msg.timestamp and tied.id <> last_msg.id
      )
  ), changed as (
    update public.whatsapp_threads t
    set status = 'closed', updated_at = v_now
    from eligible e
    where t.id = e.id and t.tenant_id = e.tenant_id
      and t.status = 'open' and t.match_status = 'matched' and t.unread_count = 0
      and t.last_message_at = e.last_message_at and t.updated_at = e.updated_at
    returning t.id
  )
  select (select count(*) from candidates), (select count(*) from changed)
    into v_scanned, v_closed;

  insert into public.system_job_runs
    (job_key, job_name, source, started_at, finished_at, status,
     processed_count, success_count, metadata)
  values
    ('whatsapp-auto-close', 'Chiusura chat WhatsApp inattive', 'supabase/cron',
     v_now, clock_timestamp(), 'success', v_scanned, v_closed,
     jsonb_build_object('cutoff', v_cutoff, 'inactivity_hours', 24,
                        'scanned', v_scanned, 'closed', v_closed,
                        'skipped', v_scanned - v_closed));
  return jsonb_build_object('scanned', v_scanned, 'closed', v_closed,
                           'skipped', v_scanned - v_closed, 'cutoff', v_cutoff);
end;
$function$;

revoke all on function public.close_inactive_whatsapp_threads() from public, anon, authenticated;
grant execute on function public.close_inactive_whatsapp_threads() to service_role;

-- Same name updates the schedule rather than creating duplicate jobs.
create extension if not exists pg_cron;
select cron.schedule('its-whatsapp-auto-close', '17 * * * *',
                     'select public.close_inactive_whatsapp_threads();');
