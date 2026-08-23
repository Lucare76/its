## Email pattern

All transactional email is HTML strings built with helpers from `lib/server/email-layout.ts`:

```ts
import { emailHtml, emailButton, emailDataTable, fmtDate, emailHighlightBox } from "@/lib/server/email-layout";
import { sendEmail } from "@/lib/server/send-email";

const html = emailHtml(`
  <p>Corpo email…</p>
  ${emailDataTable([["Label", "Valore"]])}
  ${emailButton("Clicca qui", url)}
`, { title: "Oggetto", preheader: "Testo preheader" });

await sendEmail({ to, subject, html });
```

- `sendEmail` gracefully returns `{ ok: true, skipped: true }` if `RESEND_API_KEY` is missing (safe in dev)
- `EMAIL_TEST_REDIRECT` env redirects all emails to a test address without changing code
- From address: `noreply@ischiatransferservice.it` (default) — override via `AGENCY_BOOKING_FROM_EMAIL`
- Logo in emails: always use `https://ischia-transfer.vercel.app/brand/logo-email-header.png` (hardcoded in `emailHtml`)

## Token pattern for public email links

Two patterns coexist:
1. **HMAC self-contained** (`lib/server/agency-action-token.ts`) — no DB needed, signed payload with expiry
2. **UUID in DB** (`booking_approval_tokens` table) — for tokens that need to be revoked or tracked

The public page handling the token (`app/agency-action/page.tsx`) is a `"use client"` component that calls an API route for verification and action.

## WhatsApp

`lib/server/whatsapp.ts` — core utilities:
- `normalizeWhatsAppWaId(input)` — for wa_ids from Meta webhooks (treats as already international, just adds `+`)
- `normalizeE164(input, defaultCountryCode="+39")` — for user-entered Italian phone numbers
- `sendWhatsAppMessage()` / `sendWhatsAppTextMessage()` — outbound
- `mapWebhookStatus()` / `logWhatsAppEvent()` / `isWhatsAppCustomerCareWindowOpen()`

`lib/server/whatsapp/` subdirectory:
- `matching.ts` — matches inbound wa_id to a service booking
- `webhook-processing.ts` — processes Meta webhook payloads
