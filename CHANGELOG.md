# Changelog

## Unreleased

### Added
- New script `pnpm seed:sample-pdf <path>` to ingest a local PDF via inbound endpoint and create a draft service end-to-end.
- Public service share route `/share/service/[token]` with dynamic metadata + dedicated OG image for WhatsApp previews.
- API for admin/operator to generate/revoke share links: `/api/services/share-link`.
- Migration `0011_service_share_tokens.sql` adding `share_token` and `share_expires_at` to services.
- Export services route now supports validated querystring filters on `GET /api/exports/services.xlsx` (`dateFrom`, `dateTo`, multi `status`, `ship`, `zone`, `hotel_id`, `search`, `serviceType`).
- New migration `0009_inbound_attachments_and_needs_review.sql`:
  - status `needs_review`
  - inbound email metadata columns
  - `inbound_email_attachments` table with RLS
- New migration `0010_whatsapp_events_kind.sql` adding `kind` metadata for reminder phase (`24h`, `2h`, `manual`, `webhook`).
- Health API/UI now exposes `features.excel_export_route_enabled`.

### Changed
- PDF/email parser improved for real-world Italian agency confirmations (e.g. `31-mag-26`, `Dalle14:20`, `Cliente`, `Cellulare/Tel.`) with normalized date/phone.
- Inbox operator view now shows parser confidence badges (`low/medium/high`) per suggested field.
- Dashboard service detail now includes WhatsApp share UX (generate link, copy, open WhatsApp, revoke).
- Global metadata now includes full Open Graph and Twitter card defaults.
- Health endpoint now checks share route and share OG image generator presence.
- Export workbook generation updated with:
  - fixed sheets `Transfers` and `Bus Tours`
  - `Status events` sheet
  - freeze first row
  - auto column width
  - header styling attempt for bold compatibility
- Export UI modal supports multi-status selection and querystring-based download flow.
- Inbound email endpoint `/api/inbound/email` now accepts attachment payload in canonical format (`filename`, `mimetype`, `base64`) with backward compatibility for `nome`.
- Inbound draft service creation now uses `status = needs_review`.
- Inbox UI now shows side-by-side preview of email body and extracted PDF text.
- WhatsApp event logging enriched with `kind` across cron/manual/webhook flows.

### Fixed
- Route handlers for both `/api/exports/services.xlsx` and `/api/exports/services` now support `GET` in addition to `POST`.
- Service filters/export schemas now include `needs_review` status consistently.
