-- Stato di revisione dell'estratto conto da parte dell'agenzia: 'pending'
-- finche' non risponde, 'approved' se conferma che e' tutto corretto in un
-- unico click, 'disputed' se ha inviato correzioni (in blocco, non piu' una
-- email per riga contestata — vedi app/api/agency/invoices/[id]/review e
-- app/api/agency/statement-token).

alter table public.agency_invoices
  add column if not exists agency_review_status text not null default 'pending'
    check (agency_review_status in ('pending', 'approved', 'disputed')),
  add column if not exists agency_reviewed_at timestamptz null;

notify pgrst, 'reload schema';
