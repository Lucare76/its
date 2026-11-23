-- Conserva solo gli identificativi dei biglietti contenuti nel PDF Medmar,
-- senza archiviare il PDF o i dati personali del passeggero.
alter table public.medmar_delivery_attempts
  add column if not exists ticket_numbers text[] not null default '{}';

-- La tabella esistente ha RLS tenant-scoped. La lettura per confronto fattura
-- avviene esclusivamente dal server con service_role e controllo membership.
