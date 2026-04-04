# Beta Launch Checklist

## Env obbligatorie per beta
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `NEXT_PUBLIC_APP_URL`
- `PDF_PREVIEW_USER_EMAIL`
- `PDF_PREVIEW_USER_PASSWORD`

## Env opzionali ma note
- `RESEND_API_KEY`, `AGENCY_BOOKING_FROM_EMAIL`, `AGENCY_BOOKING_BETA_RECIPIENT_EMAIL`
  Email agenzia non bloccante finche il dominio non e verificato.
- `EMAIL_INBOUND_TOKEN`, `IMAP_*`
  Necessarie solo per inbox/import da mailbox.
- `WHATSAPP_*`, `CRON_SECRET`
  Necessarie solo per reminder WhatsApp/job schedulati.

## Ordine verifica prima della beta
1. Apri `/health` e verifica env core presenti.
2. Esegui `pnpm lint`.
3. Esegui `pnpm build`.
4. Esegui `node scripts/run-beta-smoke.mjs`.
5. Apri `/pdf-imports` e verifica almeno un record `draft/confirmed`.
6. Apri `/dashboard` e controlla badge `PDF`, `Reviewed`, KPI PDF.
7. Apri `/dispatch` e controlla filtri `Solo PDF`, `Reviewed`, `Qualita low`.

## Smoke test manuale minimo
1. Area Agenzia: crea booking e verifica lista.
2. PDF: preview -> import draft -> review -> confirm.
3. Dashboard: verifica comparsa del servizio PDF.
4. Dispatch: verifica assegnazione di un booking PDF.
5. Pricing: apri `/pricing` e controlla che non ci siano regressioni.

## Controlli ogni mattina
- `Inbox da revisionare` in dashboard.
- `PDF da verificare` in dashboard.
- servizi `new` o `needs_review` in dispatch/dashboard.
- eventuali `duplicate` o `ignored` in `/pdf-imports`.
- reminder non consegnati, se WhatsApp e attivo.

## Problemi noti / limiti
- Resend non pronto finche il dominio mittente non viene verificato.
- Parser dedicato reale attivo solo per `agency_aleste_viaggi`.
- Gli altri parser dedicati sono ancora stub controllati.
- Nessuna audit table persistente: i log operativi sono su stdout/server logs.
