create index if not exists idx_medmar_delivery_ticket_numbers
  on public.medmar_delivery_attempts using gin(ticket_numbers);
