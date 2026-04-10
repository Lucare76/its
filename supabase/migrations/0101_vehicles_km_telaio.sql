-- Aggiunge chilometri e numero telaio ai veicoli
alter table public.vehicles
  add column if not exists km       integer null,
  add column if not exists telaio   text    null;
