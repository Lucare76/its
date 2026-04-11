-- Migration: Tracciamento pagamenti agenzia su singolo servizio

alter table public.services
  add column if not exists agency_payment_status text not null default 'unpaid'
    check (agency_payment_status in ('unpaid', 'paid', 'waived')),
  add column if not exists agency_paid_at date null;
