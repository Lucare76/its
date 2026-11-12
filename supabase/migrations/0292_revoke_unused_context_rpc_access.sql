-- Queste funzioni di contesto non sono richiamate da policy RLS né dal codice
-- applicativo; rimuoviamo quindi l'accesso RPC per authenticated.
-- Le restanti funzioni di contesto sono mantenute: proteggono centinaia di
-- policy multi-tenant e richiedono un refactor dedicato, non una revoca diretta.

revoke execute on function public.current_agency_id() from authenticated;
revoke execute on function public.has_capability(text) from authenticated;
revoke execute on function public.is_agency() from authenticated;
revoke execute on function public.is_driver() from authenticated;

alter function public.current_user_role() set search_path = public, pg_temp;
