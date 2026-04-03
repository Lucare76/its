alter table public.email_import_tests
  add column if not exists source_pdf text null,
  add column if not exists practice_number text null,
  add column if not exists practice_date date null,
  add column if not exists first_beneficiary text null,
  add column if not exists ns_reference text null,
  add column if not exists ns_contact text null,
  add column if not exists pax integer null,
  add column if not exists program text null,
  add column if not exists package_description text null,
  add column if not exists date_from date null,
  add column if not exists date_to date null,
  add column if not exists total_amount_practice numeric(10,2) null,
  add column if not exists service_rows_json jsonb not null default '[]'::jsonb,
  add column if not exists operational_details_json jsonb not null default '[]'::jsonb,
  add column if not exists parsed_services_json jsonb not null default '[]'::jsonb,
  add column if not exists import_status text not null default 'parsed',
  add column if not exists duplicate_flag boolean not null default false,
  add column if not exists duplicate_of_id uuid null references public.email_import_tests (id) on delete set null,
  add column if not exists operator_review_status text not null default 'needs_review',
  add column if not exists parsing_confidence text null,
  add column if not exists anomaly_message text null;

create index if not exists idx_email_import_tests_practice_number
  on public.email_import_tests (practice_number);

create index if not exists idx_email_import_tests_duplicate_flag
  on public.email_import_tests (duplicate_flag, created_at desc);
