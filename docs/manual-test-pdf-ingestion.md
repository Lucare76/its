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

## Test reale con `samples/prova1.pdf` (creazione draft service)
PowerShell (da root progetto):

```powershell
$pdfBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("samples/prova1.pdf"))

$payload = @{
  subject = "Conferma ordine pratica 26/003114"
  from = "booking@example.com"
  body_text = "Allegata conferma ordine transfer."
  attachments = @(
    @{
      filename = "prova1.pdf"
      mimetype = "application/pdf"
      base64 = $pdfBase64
    }
  )
} | ConvertTo-Json -Depth 6

Invoke-RestMethod `
  -Method POST `
  -Uri "http://localhost:3000/api/inbound/email" `
  -Headers @{ "x-inbound-token" = "$env:EMAIL_INBOUND_TOKEN" } `
  -ContentType "application/json" `
  -Body $payload
```

Atteso:
- `ok: true` con `draft_service_id`.
- su `inbound_emails.extracted_text` testo del PDF valorizzato.
- draft service creato con:
  - `status = needs_review`
  - `customer_name` da `Cliente: ...`
  - `phone` da `Cellulare/Tel. ...`
  - `date/time` da righe `Il ...` / `Dalle...`
  - `vessel` da `CON MEDMAR` (se presente).

## Seed command end-to-end da PDF locale
Con app in esecuzione (`pnpm dev`):

```bash
pnpm seed:sample-pdf samples/prova1.pdf
```

Oppure con il file richiesto:

```bash
pnpm seed:sample-pdf samples/agency-transfer-example.pdf
```

Se il file non esiste, lo script mostra i sample disponibili in `samples/`.

## Query SQL di verifica
```sql
select id, created_at, left(raw_text, 120) as raw_preview, left(extracted_text, 120) as extracted_preview
from public.inbound_emails
where extracted_text is not null
order by created_at desc
limit 5;
```
