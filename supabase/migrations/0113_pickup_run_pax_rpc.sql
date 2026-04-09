-- Migration 0113: RPC per aggiornamento atomico total_pax su pickup_runs

create or replace function public.increment_pickup_run_pax(
  p_run_id uuid,
  p_delta  integer
)
returns void
language plpgsql
security definer
as $$
begin
  update public.pickup_runs
  set total_pax = greatest(0, total_pax + p_delta)
  where id = p_run_id;
end;
$$;
