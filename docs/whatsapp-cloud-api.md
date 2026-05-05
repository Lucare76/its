# WhatsApp Cloud API inbound webhook

## Variabili ambiente

Impostare in `.env.local` e in Vercel, senza committare valori reali:

```env
WHATSAPP_VERIFY_TOKEN=
WHATSAPP_APP_SECRET=
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_BUSINESS_ACCOUNT_ID=
WHATSAPP_GRAPH_API_VERSION=v23.0
```

Nota: `WHATSAPP_ACCESS_TOKEN` deve essere un System User Token Meta permanente. `WHATSAPP_TOKEN` resta solo come fallback legacy durante la migrazione.

## Webhook Meta Developers

1. Apri Meta Developers, app collegata a WhatsApp Business Platform.
2. Vai in WhatsApp > Configuration.
3. Callback URL produzione: `https://TUO-DOMINIO/api/whatsapp/webhook`.
4. Verify token: stesso valore di `WHATSAPP_VERIFY_TOKEN`.
5. Sottoscrivi il campo `messages`.
6. Salva e verifica.

La verifica `GET /api/whatsapp/webhook` restituisce `hub.challenge` in `text/plain` solo se `hub.mode=subscribe` e il token coincide.

## Ricezione risposte cliente

`POST /api/whatsapp/webhook`:

- legge il raw body;
- valida `X-Hub-Signature-256` con HMAC SHA256 e `WHATSAPP_APP_SECRET`;
- salva il payload in `whatsapp_webhook_events`;
- processa `messages` e `statuses`;
- deduplica con `wamid`/status timestamp;
- risponde `200 OK` anche se un singolo messaggio non e associabile.

I raw payload restano solo server-side e non sono esposti nella Inbox.

## Tabelle

Migration: `supabase/migrations/0175_whatsapp_cloud_inbox.sql`.

- `whatsapp_webhook_events`: archivio raw webhook Meta.
- `whatsapp_contacts`: contatti WhatsApp per tenant.
- `whatsapp_threads`: conversazioni Inbox, unread, stato review.
- `whatsapp_messages`: messaggi inbound/outbound.
- `whatsapp_message_statuses`: stati `sent`, `delivered`, `read`, `failed`.

Il webhook scrive con service role. Gli utenti autenticati leggono thread/messaggi solo per `current_tenant_id()`. I raw webhook non hanno policy di lettura client.

## Matching iniziale

Il matching prova:

1. telefono esatto su `services.phone` e `services.phone_e164`;
2. telefono normalizzato ignorando spazi, `+`, zeri, trattini;
3. servizio futuro piu vicino se resta un solo candidato;
4. codice pratica nel testo su `services.external_code`, `notes`, `message_id`;
5. se piu risultati: thread `needs_review` con suggerimenti;
6. se nessun match: contatto/thread non associato, quando il tenant e risolvibile.

Non aggiorna automaticamente prenotazioni o stati operativi.

## Test locale

Verifica GET:

```bash
curl "http://localhost:3010/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=$WHATSAPP_VERIFY_TOKEN&hub.challenge=ok123"
```

Generare una firma dev con Node:

```bash
node -e "const crypto=require('crypto'); const body=process.argv[1]; const secret=process.env.WHATSAPP_APP_SECRET; console.log('sha256='+crypto.createHmac('sha256', secret).update(body).digest('hex'))" '{"object":"whatsapp_business_account","entry":[]}'
```

Invio POST:

```bash
BODY='{"object":"whatsapp_business_account","entry":[]}'
SIG=$(node -e "const crypto=require('crypto'); const body=process.argv[1]; const secret=process.env.WHATSAPP_APP_SECRET; console.log('sha256='+crypto.createHmac('sha256', secret).update(body).digest('hex'))" "$BODY")
curl -X POST "http://localhost:3010/api/whatsapp/webhook" \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: $SIG" \
  --data "$BODY"
```

## Inbox

Pagina: `/whatsapp`.

Funzioni presenti:

- lista conversazioni ordinate per ultimo messaggio;
- badge unread;
- filtri aperte, da rivedere, associate, non associate, chiuse;
- ricerca per nome, telefono, tipo servizio, hotel e preview;
- dettaglio conversazione;
- evidenza thread non associati;
- azioni segna come letto, chiudi, riapri;
- pulsante associazione manuale presente ma disabilitato per step futuro.

La voce menu non e stata aggiunta.

## Log

Controllare:

- Vercel Function Logs per `/api/whatsapp/webhook`;
- tabella `whatsapp_webhook_events` per archivio raw;
- tabella `whatsapp_threads` per stato Inbox;
- tabella legacy `whatsapp_events` per delivery dei template esistenti.

## Limitazioni iniziali

- Download allegati Meta non implementato: si salvano solo `media_id`, mime e sha.
- Invio manuale dalla Inbox non implementato.
- Associazione manuale a prenotazione non implementata.
- In installazioni multi-tenant con piu numeri WhatsApp serve mappare `phone_number_id` a tenant.

## Prossimi step

1. Invio template da gestionale usando `WHATSAPP_ACCESS_TOKEN`.
2. Allegati e QR code bus con download media sicuro.
3. Automazioni conferma transfer con suggerimenti, non auto-azioni rischiose.
4. Escalation a operatore e assegnazione thread.
5. AI suggestion per classificare risposte, senza modificare prenotazioni automaticamente.
