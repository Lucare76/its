# Agency Registry And Permissions

## Obiettivo

Preparare una base unica per:

- anagrafica agenzia
- alias e varianti OCR
- domini mittenti utili ai parser
- servizi default da proporre
- base per listini dedicati per agenzia
- matrice permessi del gestionale

## Campi Anagrafica Agenzia

Tabella: `public.agencies`

Campi core:

- `name`: nome breve operativo
- `legal_name`: ragione sociale
- `billing_name`: intestazione fatturazione
- `contact_email`: email contatto
- `booking_email`: email booking
- `phone`: telefono
- `external_code`: codice esterno opzionale
- `parser_key_hint`: hint parser preferito
- `sender_domains`: domini email mittenti noti
- `default_enabled_booking_kinds`: servizi da proporre di default
- `default_pricing_notes`: note per costruire il listino default
- `notes`: note operative interne

## Uso Pratico

L'anagrafica agenzia serve per:

- riconoscere meglio l'agenzia nei PDF
- valorizzare correttamente `billing_party_name`
- proporre servizi standard da attivare per quella agenzia
- creare un listino default per i servizi piu frequenti
- lasciare al cliente la possibilita di aggiungere manualmente i servizi extra

## Strategia Listini

Separare sempre:

- dati operativi pubblici
  - linee bus
  - orari
  - citta di partenza
  - meeting point

- dati commerciali per agenzia
  - listino default dedicato
  - eccezioni stagionali
  - servizi extra non standard

## Permessi Gestionali

Matrice iniziale:

- `admin`
  - gestisce anagrafiche agenzie
  - gestisce listini e regole prezzo
  - vede debug PDF e dettagli tecnici
  - gestisce WhatsApp e configurazioni sensibili

- `operator`
  - gestisce inbox, dispatch, planning, import PDF
  - vede storico pricing
  - non dovrebbe modificare anagrafiche critiche o regole prezzo definitive

- `agency`
  - vede solo proprie prenotazioni e nuova prenotazione
  - non vede dati tecnici parser
  - non vede regole prezzo interne

- `driver`
  - vede solo i propri servizi

## Step Successivi Consigliati

1. aggiungere CRUD completo anagrafica agenzie
2. collegare `sender_domains` e alias al matching parser
3. generare listino default per agenzia dai servizi standard
4. nascondere dettagli tecnici a chi non ha capability `pdf_imports:debug`
