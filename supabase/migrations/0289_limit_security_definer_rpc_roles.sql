-- I privilegi EXECUTE assegnati a PUBLIC raggiungono anche il ruolo anonimo.
-- Le RPC di scrittura sono esclusivamente server-side: service_role le conserva,
-- mentre anon e authenticated non possono invocarle direttamente.

revoke execute on function public.acquire_email_import_lock(uuid,text,integer,integer,boolean) from public, authenticated;
revoke execute on function public.allocate_bus_service(uuid,uuid,uuid,uuid,uuid,text,public.service_direction,integer,text,uuid) from public, authenticated;
revoke execute on function public.cancel_service_practice(uuid,uuid,text,text,text,uuid) from public, authenticated;
revoke execute on function public.delete_shuttle_schedule(uuid,date,text,text,text,text,uuid,text,text) from public, authenticated;
revoke execute on function public.finalize_cancellation_request(uuid,uuid,uuid,text,text,text,integer,integer,text) from public, authenticated;
revoke execute on function public.increment_pickup_run_pax(uuid,integer) from public, authenticated;
revoke execute on function public.move_bus_allocation(uuid,uuid,uuid,integer,text,uuid) from public, authenticated;
revoke execute on function public.next_booking_practice_number(uuid) from public, authenticated;
revoke execute on function public.next_quote_number(uuid) from public, authenticated;
revoke execute on function public.patch_shuttle_schedule(uuid,date,text,text,text,text,uuid,text,text,jsonb) from public, authenticated;
revoke execute on function public.release_email_import_lock(uuid,text,boolean,text) from public, authenticated;
revoke execute on function public.reorder_bus_line_stops(uuid,uuid,public.service_direction,uuid[]) from public;

-- Le funzioni di contesto continuano a essere disponibili agli utenti autenticati
-- per le policy RLS, ma non sono più chiamabili da anon.
revoke execute on function public.current_agency_id() from public;
revoke execute on function public.current_tenant_id() from public;
revoke execute on function public.current_user_role() from public;
revoke execute on function public.has_capability(text) from public;
revoke execute on function public.is_admin() from public;
revoke execute on function public.is_agency() from public;
revoke execute on function public.is_driver() from public;
revoke execute on function public.is_operator() from public;
