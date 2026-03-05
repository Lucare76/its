# Changelog

## Unreleased

### Added
- Export services route now supports validated querystring filters on `GET /api/exports/services.xlsx` (`dateFrom`, `dateTo`, multi `status`, `ship`, `zone`, `hotel_id`, `search`, `serviceType`).
- New migration `0009_inbound_attachments_and_needs_review.sql`:
  - status `needs_review`
  - inbound email metadata columns
  - `inbound_email_attachments` table with RLS
- New migration `0010_whatsapp_events_kind.sql` adding `kind` metadata for reminder phase (`24h`, `2h`, `manual`, `webhook`).
- Health API/UI now exposes `features.excel_export_route_enabled`.

### Changed
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

