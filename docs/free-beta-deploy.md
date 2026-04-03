# Deploy beta gratuito

## Compatibilita Vercel Hobby
- La vetrina pubblica (`/`, `/servizi`, `/flotta`, `/chi-siamo`, `/contatti`, `/preventivo`) e compatibile con Vercel Hobby.
- Non esiste alcun cron obbligatorio per la beta marketing.
- Non esistono dipendenze enterprise obbligatorie.
- Il form preventivo funziona anche senza backend: genera direttamente nel browser link `WhatsApp` e `mailto`.

## Configurazione minima consigliata
Inserisci solo:

```env
NEXT_PUBLIC_APP_URL=https://tuodominio.vercel.app
NEXT_PUBLIC_DISABLE_SUPABASE=true
```

Con questa configurazione:
- la parte pubblica resta operativa
- Supabase non e richiesto
- WhatsApp Cloud API non e richiesta
- IMAP, Resend e job reminder non sono richiesti

## Funzioni opzionali, non necessarie alla beta
- login e backoffice operativo
- integrazione Supabase
- import email IMAP
- invio email automatico
- reminder WhatsApp
- API cron/job

## Nota importante
Il repository contiene ancora moduli operativi avanzati pensati per fasi successive. Possono restare nel progetto senza impedire il deploy gratuito della beta marketing, ma non devono essere considerati prerequisiti del lancio pubblico iniziale.
