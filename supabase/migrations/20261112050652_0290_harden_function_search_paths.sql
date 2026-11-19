-- Fissa il search_path delle funzioni applicative e rimuove l'ultima RPC
-- operativa dall'accesso diretto authenticated. Le funzioni di contesto
-- restano callable da authenticated perché sono richiamate dalle policy RLS.

revoke execute on function public.reorder_bus_line_stops(uuid,uuid,public.service_direction,uuid[]) from authenticated;

alter function public.current_agency_id() set search_path = public, pg_temp;
alter function public.current_tenant_id() set search_path = public, pg_temp;
alter function public.enforce_bgbr_exclusive_exclusion() set search_path = public, pg_temp;
alter function public.fn_services_resolve_agency_id() set search_path = public, pg_temp;
alter function public.has_capability(text) set search_path = public, pg_temp;
alter function public.increment_pickup_run_pax(uuid,integer) set search_path = public, pg_temp;
alter function public.is_admin() set search_path = public, pg_temp;
alter function public.is_agency() set search_path = public, pg_temp;
alter function public.is_driver_assigned_service(uuid) set search_path = public, pg_temp;
alter function public.is_driver() set search_path = public, pg_temp;
alter function public.is_operator() set search_path = public, pg_temp;
alter function public.next_quote_number(uuid) set search_path = public, pg_temp;
alter function public.set_booking_qr_codes_updated_at() set search_path = public, pg_temp;
alter function public.set_cancellation_requests_updated_at() set search_path = public, pg_temp;
alter function public.set_medmar_ar_pending_updated_at() set search_path = public, pg_temp;
alter function public.set_modification_requests_updated_at() set search_path = public, pg_temp;
alter function public.set_operations_suggestions_updated_at() set search_path = public, pg_temp;
alter function public.set_service_cancellation_penalties_updated_at() set search_path = public, pg_temp;
alter function public.touch_medmar_credit_settings_updated_at() set search_path = public, pg_temp;
alter function public.touch_medmar_issuing_attempts_updated_at() set search_path = public, pg_temp;
alter function public.touch_role_capability_overrides_updated_at() set search_path = public, pg_temp;
alter function public.touch_tenant_access_requests_updated_at() set search_path = public, pg_temp;
alter function public.touch_user_capability_overrides_updated_at() set search_path = public, pg_temp;
alter function public.touch_whatsapp_auto_reply_logs_updated_at() set search_path = public, pg_temp;
alter function public.touch_whatsapp_cost_updated_at() set search_path = public, pg_temp;
alter function public.touch_whatsapp_messages_updated_at() set search_path = public, pg_temp;
alter function public.vehicle_document_object_authorized(text) set search_path = public, pg_temp;
