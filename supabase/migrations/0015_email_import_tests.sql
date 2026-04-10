create table if not exists public.email_import_tests (
  id uuid primary key default gen_random_uuid(),
  sender_email text not null default '',
  subject text not null default '',
  received_at timestamptz not null default now(),
  pdf_filename text null,
  extracted_text text null,
  raw_email text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_email_import_tests_created_at
  on public.email_import_tests (created_at desc);

alter table public.email_import_tests enable row level security;
