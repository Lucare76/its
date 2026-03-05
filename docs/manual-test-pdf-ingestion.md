# Manual Test: PDF Attachment Ingestion (No OCR)

## Prerequisiti
- App avviata (`pnpm dev`).
- Env configurate (`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `EMAIL_INBOUND_TOKEN`).
- Migration DB applicata con colonna `public.inbound_emails.extracted_text`.
- Un PDF testuale (non scansione) disponibile in locale.

## Test via UI
1. Apri `/ingestion`.
2. In `Attachments metadata`, usa almeno un allegato PDF:
   ```json
   [{"filename":"voucher.pdf","mime_type":"application/pdf","size_bytes":12345}]
   ```
3. Carica il file nel campo `PDF upload`.
4. Invia `Send test inbound email`.
5. Verifica in Supabase che la riga su `inbound_emails` abbia:
   - `raw_text` valorizzato.
   - `extracted_text` valorizzato con testo estratto dal PDF.
6. Apri `/inbox`, seleziona la email e verifica che i suggerimenti parser includano campi presenti solo nel PDF (se assenti nel body).

## Query SQL di verifica
```sql
select id, created_at, left(raw_text, 120) as raw_preview, left(extracted_text, 120) as extracted_preview
from public.inbound_emails
where extracted_text is not null
order by created_at desc
limit 5;
```
