# Audit funzionale 2026-06-29 - interventi non invasivi

Documento operativo per chiudere i punti dell'audit che non cambiano il comportamento produttivo del gestionale.

## Completato

- Rimosso l'arricchimento OpenAI dei suggerimenti operativi.
  - Motivo: l'audit lo indicava come codice morto con endpoint non affidabile.
  - Impatto funzionale: nullo. Il sistema usava gia fallback alla descrizione rule-based; ora usa direttamente quella.

## Non attivato automaticamente

- `app/api/cron/agency-bus-monday`
  - Stato: endpoint presente e protetto da `CRON_SECRET`.
  - Decisione: non registrato in `vercel.json` in questa fase.
  - Motivo: registrarlo attiverebbe invii email automatici alle agenzie, quindi e un cambio funzionale.

- `app/api/cron/whatsapp-reminders`
  - Stato: endpoint presente e protetto da `CRON_SECRET`/`WHATSAPP_CRON_SECRET`.
  - Decisione: non registrato in `vercel.json` in questa fase.
  - Motivo: registrarlo attiverebbe invii WhatsApp automatici; il sistema usa gia `push-reminders` schedulato.

## Prossimi interventi sicuri

- UI storico assegnazioni autisti: aggiunta read-only, senza cambiare logica di assegnazione.
- Logging strutturato post-lancio: aggiunta osservabilita, senza cambiare flussi.
- Learned patterns nel driver scoring: da fare solo dietro flag/preview, per evitare impatto sulle assegnazioni.
