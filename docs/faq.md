# FAQ

## Accesso e ruoli

### 1. Non vedo alcune pagine nel menu, e normale?
Si. Il menu dipende dal ruolo (`admin`, `operator`, `driver`, `agency`) e dalle policy RLS.

### 2. Posso usare lo stesso account per ruoli diversi?
No, e consigliato un account distinto per ruolo per audit e sicurezza.

## Prenotazioni e dispatch

### 3. Ho creato un servizio ma non appare in Dispatch.
Controlla:
- tenant corretto
- data/filtri
- eventuale assegnazione gia presente

### 4. Perche non posso assegnare un driver?
Servono permessi `admin` o `operator`. Verifica anche disponibilita driver e stato servizio.

## Driver app

### 5. Il driver non puo cambiare stato, perche?
Con RLS attiva, puo aggiornare solo i servizi assegnati al suo utente.

### 6. Cosa succede se il driver e offline?
Le azioni stato vengono accodate localmente e sincronizzate appena torna online.

## WhatsApp

### 7. I messaggi WhatsApp non partono.
Verifica:
- `WHATSAPP_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_VERIFY_TOKEN`
- health check env WhatsApp

### 8. Perche vedo badge "Non consegnato"?
Il webhook non ha ricevuto delivery entro la soglia prevista. Va verificata la consegna nel Business Manager/Meta logs.

## Export e report

### 9. L'export Excel non funziona.
In demo mode senza Supabase configurato, il download reale puo essere disabilitato con messaggio fallback.

### 10. Dove trovo i documenti operativi?
Indice completo in [README docs](./README.md).

## Placeholder screenshot (da sostituire)
- `[SCREENSHOT: login ruolo]`
- `[SCREENSHOT: dashboard operator]`
- `[SCREENSHOT: dispatch assegnazione]`
- `[SCREENSHOT: driver mobile status buttons]`
- `[SCREENSHOT: export xlsx]`

