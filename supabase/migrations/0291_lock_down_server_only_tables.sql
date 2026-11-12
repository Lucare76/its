-- Queste tabelle sono esclusivamente tecniche: contatori, audit, deduplica
-- notifiche e payload raw dei webhook. Nessun client deve interrogare o
-- modificare i dati direttamente; resta autorizzato solo il server service_role.

revoke all on table public.booking_practice_counters from public, anon, authenticated;
grant all on table public.booking_practice_counters to service_role;

revoke all on table public.mcp_audit_logs from public, anon, authenticated;
grant all on table public.mcp_audit_logs to service_role;

revoke all on table public.push_notification_log from public, anon, authenticated;
grant all on table public.push_notification_log to service_role;

revoke all on table public.whatsapp_webhook_events from public, anon, authenticated;
grant all on table public.whatsapp_webhook_events to service_role;
