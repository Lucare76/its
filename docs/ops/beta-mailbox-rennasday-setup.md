# Beta Mailbox Setup (Gmail IMAP)

Mailbox beta operativa: `rennasday@gmail.com`.

## Env richieste
```env
IMAP_HOST=imap.gmail.com
IMAP_PORT=993
IMAP_USER=rennasday@gmail.com
IMAP_PASS=APP_PASSWORD_GMAIL
IMAP_TLS=true
IMAP_MAILBOX=INBOX
```

Note:
- usare **App Password Gmail** (2FA attiva), mai password account standard.
- nessuna credenziale hardcoded nel codice.

## Compatibilita pipeline
- `/api/inbound/email`: webhook inbound token-based, idempotenza `practice_number` su `services.notes` marker `[practice:XX/XXXXXX]`.
- `/api/email/import-pdf`: upload manuale PDF, stessa logica idempotente su `practice_number`.
- `/api/email/test-import`: ingestion IMAP reale, ora compatibile con env `IMAP_*` (fallback legacy `EMAIL_*` mantenuto).

## Verifica rapida
1. Configura env in Vercel/Supabase runtime.
2. Vai su `/health` e verifica presenza:
- `IMAP_HOST`, `IMAP_PORT`, `IMAP_USER`, `IMAP_PASS`, `IMAP_TLS`.
3. Da UI `/inbox` usa "Aggiorna import test" (chiama `/api/email/test-import`).
4. Verifica record su `email_import_tests`.

## Sicurezza operativa
- ruotare periodicamente `IMAP_PASS`.
- limitare account mailbox a uso tecnico.
- non committare mai `.env.local`.
