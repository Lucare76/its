-- Migration: store extracted text from non-OCR PDF attachments
alter table public.inbound_emails
  add column if not exists extracted_text text null;
