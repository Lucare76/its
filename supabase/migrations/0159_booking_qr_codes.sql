-- Formalizza la tabella booking_qr_codes come migrazione ufficiale.
-- La tabella esisteva già nel DB (vuota); questo script è idempotente.
--
-- Ogni prenotazione agenzia ottiene 2 QR code:
--   outbound → URL /scan/{token} per la tratta ANDATA
--   return   → URL /scan/{token} per la tratta RITORNO
--
-- I token sono esadecimali a 36 caratteri (18 byte, no trattini), distinguibili
-- dalle UUID di services che hanno la forma xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.

create table if not exists public.booking_qr_codes (
  id           uuid        primary key default gen_random_uuid(),
  booking_id   uuid        not null references public.services(id) on delete cascade,
  direction    text        not null check (direction in ('outbound', 'return')),
  qr_token     text        not null unique,
  qr_payload   jsonb,
  qr_image_url text,
  qr_file_path text,
  service_date date,
  status       text        not null default 'active'
                           check (status in ('active', 'used', 'expired', 'revoked')),
  used_at      timestamptz,
  used_by      uuid        references auth.users(id),
  tenant_id    uuid        not null references public.tenants(id) on delete cascade,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Vincolo unique (booking_id, direction) — evita QR doppi per la stessa tratta
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'booking_qr_codes_booking_id_direction_key'
      and conrelid = 'public.booking_qr_codes'::regclass
  ) then
    alter table public.booking_qr_codes
      add constraint booking_qr_codes_booking_id_direction_key
      unique (booking_id, direction);
  end if;
end;
$$;

create index if not exists idx_bqr_token      on public.booking_qr_codes(qr_token);
create index if not exists idx_bqr_booking_id on public.booking_qr_codes(booking_id);
create index if not exists idx_bqr_tenant_id  on public.booking_qr_codes(tenant_id);

alter table public.booking_qr_codes enable row level security;
-- Service role bypassa RLS; nessuna policy lato client necessaria.
