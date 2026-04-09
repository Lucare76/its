# WhatsApp Cloud API Setup (MVP)

## Env richieste
Imposta in `.env.local` (e in Vercel):

- `WHATSAPP_TOKEN`: permanent/system user token Meta.
- `WHATSAPP_PHONE_NUMBER_ID`: Phone Number ID del numero WhatsApp Business.
- `WHATSAPP_VERIFY_TOKEN`: token arbitrario usato anche in Meta webhook verification.
- `WHATSAPP_TEMPLATE_NAME` (opzionale, default `transfer_reminder`).
- `WHATSAPP_TEMPLATE_LANGUAGE` (opzionale, default `it`).
- `WHATSAPP_ALLOW_TEXT_FALLBACK` (opzionale, default `false`).
- `WHATSAPP_REMINDER_WINDOW_MINUTES` (opzionale, default `15`).
- `WHATSAPP_REMINDER_2H_ENABLED` (opzionale, default `false`).

## Webhook Meta
1. In Meta Developer Dashboard vai su WhatsApp > Configuration.
2. `Callback URL`: `https://<tuo-dominio>/api/whatsapp/webhook`
3. `Verify token`: stesso valore di `WHATSAPP_VERIFY_TOKEN`.
4. Sottoscrivi almeno il campo `messages`.

## Endpoint implementati
- `POST /api/whatsapp/send`
  - richiede `Authorization: Bearer <supabase_access_token>`
  - RBAC: solo `admin` o `operator`
  - body: `{ "service_id": "<uuid>" }`
- `GET /api/whatsapp/webhook`
  - verifica Meta (`hub.challenge`)
- `POST /api/whatsapp/webhook`
  - ricezione stati (`sent`, `delivered`, `read`, `failed`)
- `GET/POST /api/whatsapp/settings`
  - configurazione tenant (solo admin)

## Persistenza eventi
Tabella `public.whatsapp_events`:
- `tenant_id`, `service_id`, `to_phone`, `template`, `status`, `provider_message_id`, `happened_at`, `payload_json`.

Viene popolata da:
- invio manuale `/api/whatsapp/send`
- invio cron `/api/cron/whatsapp-reminders`
- callback webhook `/api/whatsapp/webhook`
- configurazione admin `/settings/whatsapp`

## Scheduler reminder
- Endpoint cron: `GET/POST /api/cron/whatsapp-reminders`
- Schedulazione raccomandata su Vercel: ogni 15 minuti.
- Filtra servizi con stato compatibile (`new`, `assigned`) e pickup in finestra:
  - `24h` (sempre)
  - `2h` (solo se `WHATSAPP_REMINDER_2H_ENABLED=true`)
- Deduplica invii per fase tramite eventi esistenti:
  - `whatsapp_events` con `status in ('sent','delivered','read')`
  - `payload_json.phase in ('24h','2h')`
- Per tenant usa `tenant_whatsapp_settings`:
  - `default_template`
  - `template_language`
  - `enable_2h_reminder`
  - `allow_text_fallback`

## Template utility e fallback testo
- Invio primario: `type=template` (utility template configurato per tenant).
- Se template fallisce e `allow_text_fallback=true`, il sistema tenta `type=text`.
- Modalita usata viene tracciata in `whatsapp_events.payload_json.delivery_mode`.

### Query SQL utile (monitor)
```sql
select
  service_id,
  status,
  happened_at,
  payload_json->>'phase' as phase,
  to_phone
from public.whatsapp_events
where created_at > now() - interval '1 day'
order by happened_at desc
limit 100;
```

## Alert UI dashboard
- KPI `Non consegnato` in `/dashboard`.
- Badge `Non consegnato` in tabella servizi quando:
  - `reminder_status = 'sent'`
  - `sent_at` piu vecchio di `NEXT_PUBLIC_REMINDER_ALERT_MINUTES`.

## Verifica health
Apri `/health` e controlla `present` per:
- `WHATSAPP_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_VERIFY_TOKEN`
