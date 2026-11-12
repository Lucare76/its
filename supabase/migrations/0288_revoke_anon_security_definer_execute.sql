-- Blocca l'esecuzione anonima delle RPC SECURITY DEFINER.
-- Le procedure qui elencate sono invocate esclusivamente dal server tramite
-- service role; l'accesso anonimo non è necessario ed esponeva mutazioni interne.

revoke execute on function public.acquire_email_import_lock(uuid,text,integer,integer,boolean) from anon;
revoke execute on function public.allocate_bus_service(uuid,uuid,uuid,uuid,uuid,text,public.service_direction,integer,text,uuid) from anon;
revoke execute on function public.cancel_service_practice(uuid,uuid,text,text,text,uuid) from anon;
revoke execute on function public.current_agency_id() from anon;
revoke execute on function public.current_tenant_id() from anon;
revoke execute on function public.current_user_role() from anon;
revoke execute on function public.delete_shuttle_schedule(uuid,date,text,text,text,text,uuid,text,text) from anon;
revoke execute on function public.finalize_cancellation_request(uuid,uuid,uuid,text,text,text,integer,integer,text) from anon;
revoke execute on function public.has_capability(text) from anon;
revoke execute on function public.increment_pickup_run_pax(uuid,integer) from anon;
revoke execute on function public.is_admin() from anon;
revoke execute on function public.is_agency() from anon;
revoke execute on function public.is_driver() from anon;
revoke execute on function public.is_operator() from anon;
revoke execute on function public.move_bus_allocation(uuid,uuid,uuid,integer,text,uuid) from anon;
revoke execute on function public.next_booking_practice_number(uuid) from anon;
revoke execute on function public.next_quote_number(uuid) from anon;
revoke execute on function public.patch_shuttle_schedule(uuid,date,text,text,text,text,uuid,text,text,jsonb) from anon;
revoke execute on function public.release_email_import_lock(uuid,text,boolean,text) from anon;
revoke execute on function public.reorder_bus_line_stops(uuid,uuid,public.service_direction,uuid[]) from anon;
