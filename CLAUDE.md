# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev              # dev server on port 3010 (0.0.0.0)
pnpm build            # Next.js production build
pnpm typecheck        # tsc --noEmit (run before every push)
pnpm lint             # ESLint across app/, components/, lib/, scripts/, tests/
pnpm test             # vitest unit tests (tests/unit/**/*.test.ts)
pnpm test:watch       # vitest watch mode
pnpm e2e:smoke        # Playwright smoke suite (needs running app)
```

Run a single unit test file:
```bash
pnpm exec vitest run tests/unit/whatsapp-utils.test.ts
```

Run E2E against a live local app:
```bash
E2E_BASE_URL=http://127.0.0.1:3010 pnpm e2e:ops
```

## Stack

- **Next.js 16 App Router** + TypeScript strict + Tailwind + pnpm
- **Supabase** (Auth + Postgres + RLS) — `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- **Resend** for transactional email — `RESEND_API_KEY`
- **WhatsApp Cloud API** (Meta) — `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`
- **Vercel** deploy with cron jobs in `vercel.json`

## Architecture

### Directory layout

```
app/
  (app)/        ← authenticated pages (layout wraps auth)
  api/ops/      ← protected API routes (require Supabase session)
  api/public/   ← public API routes (no auth)
  api/cron/     ← Vercel cron handlers
  [slug]/       ← public-facing pages (landing, quote accept, agency action)
lib/
  server/       ← server-only utilities (email, auth, PDF, WhatsApp, etc.)
  supabase/     ← Supabase client helpers
  *.ts          ← shared client+server utilities
components/     ← React components
supabase/
  migrations/   ← numbered SQL migrations (0001…0204+)
tests/
  unit/         ← Vitest tests for lib/**
  e2e/          ← Playwright tests
```

**Do not add code to `server/` or `client/` — those are legacy and frozen.**

### Auth pattern (all protected API routes)

Every `app/api/ops/` route uses `authorizePricingRequest` (a convenience alias for `authorizeServiceRoleRequest`):

```ts
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;   // 401/403 already sent
  // auth.admin  → Supabase admin client (service role)
  // auth.user   → { id, email }
  // auth.membership → { tenant_id, role, suspended }
}
```

`auth.admin` must be used (not the anon client) for all DB access inside API routes — it bypasses RLS and the service role handles multi-tenancy manually via `tenant_id` filters.

### Email pattern

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

### Token pattern for public email links

Two patterns coexist:
1. **HMAC self-contained** (`lib/server/agency-action-token.ts`) — no DB needed, signed payload with expiry
2. **UUID in DB** (`booking_approval_tokens` table) — for tokens that need to be revoked or tracked

The public page handling the token (`app/agency-action/page.tsx`) is a `"use client"` component that calls an API route for verification and action.

### Multi-tenancy / RLS

Every table has `tenant_id UUID`. RLS policies use `public.current_tenant_id()`. API routes filter by `auth.membership.tenant_id` explicitly even when using the admin client.

### Database migrations

Migrations live in `supabase/migrations/` numbered sequentially (currently 0001–0204). Add new ones as `NNNN_descriptive_name.sql`. They are applied manually via Supabase SQL Editor — `pnpm db:bootstrap` shows the file path, it does **not** run SQL automatically.

### Cron jobs

Cron endpoints live in `app/api/cron/`. Register them in `vercel.json`:
```json
{ "path": "/api/cron/my-job", "schedule": "0 8 * * *" }
```
Vercel Hobby plan limits: max 2 cron jobs (currently worked around by scheduling multiple jobs at the same time and re-routing within a single handler — or by keeping within the free tier limit).

### WhatsApp

`lib/server/whatsapp.ts` — core utilities:
- `normalizeWhatsAppWaId(input)` — for wa_ids from Meta webhooks (treats as already international, just adds `+`)
- `normalizeE164(input, defaultCountryCode="+39")` — for user-entered Italian phone numbers
- `sendWhatsAppMessage()` / `sendWhatsAppTextMessage()` — outbound
- `mapWebhookStatus()` / `logWhatsAppEvent()` / `isWhatsAppCustomerCareWindowOpen()`

`lib/server/whatsapp/` subdirectory:
- `matching.ts` — matches inbound wa_id to a service booking
- `webhook-processing.ts` — processes Meta webhook payloads

### Existing quotes system

A `quotes` table and `/api/ops/quotes` route already exist for **bus/excursion quotes sent to agencies** (`app/(app)/preventivo-ops/`). This is separate from any client-facing transfer quote system.

### Path alias

`@/` resolves to the project root (configured in `tsconfig.json` and `vitest.config.ts`).

## Key environment variables

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_APP_URL` | Canonical app URL (used in email links, must match actual domain) |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role (server-only) |
| `RESEND_API_KEY` | Resend email (optional in dev — emails are skipped) |
| `EMAIL_TEST_REDIRECT` | Redirect all emails to this address (dev/staging) |
| `NOTIFY_BCC_EMAIL` | Auto-BCC every outbound email |
| `WHATSAPP_ACCESS_TOKEN` | Meta System User Token (permanent) |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta WhatsApp phone number ID |
| `WHATSAPP_CRON_SECRET` | Auth secret for cron endpoints |
| `AGENCY_ACTION_SECRET` | HMAC secret for agency action tokens |
