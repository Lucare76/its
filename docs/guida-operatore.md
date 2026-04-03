# Guida Operatore

## Obiettivo
Gestire prenotazioni, assegnazioni driver, monitoraggio stato servizi ed export.

## Flusso principale
1. Login come `operator` o `admin`.
2. Crea servizio da `Nuovo Servizio`.
3. Vai su `Dispatch` e assegna driver/mezzo.
4. Monitora stato su `Dashboard` (`new`, `assigned`, `partito`, `arrivato`, `completato`, `problema`).
5. Esporta dati da `Export` quando necessario.

## 1) Creazione servizio
1. Apri `Nuovo Servizio` (`/services/new`).
2. Compila cliente, telefono, data/ora, nave, hotel/zona, note.
3. Salva con `Conferma prenotazione`.
4. Verifica messaggio di conferma e stato iniziale.

**Screenshot placeholder**
`[SCREENSHOT: pagina Nuovo Servizio con form compilato]`

## 2) Assegnazione driver
1. Apri `Dispatch` (`/dispatch`).
2. Seleziona il servizio da assegnare.
3. Seleziona driver e mezzo.
4. Conferma assegnazione.
5. Controlla conferma "Assegnazione salvata".

**Screenshot placeholder**
`[SCREENSHOT: pannello Dispatch con selezione driver e top suggeriti]`

## 3) Monitoraggio operativo
1. Apri `Dashboard`.
2. Usa filtri (data, stato, zona, driver) per restringere la vista.
3. Verifica badge stato e alert (es. WhatsApp non consegnato).
4. Intervieni su servizi bloccati in `problema`.

**Screenshot placeholder**
`[SCREENSHOT: Dashboard con badge stato e alert]`

## 4) Export report
1. Da `Dashboard`, apri `Export`.
2. Scegli filtri periodo/stato.
3. Esegui `Download .xlsx`.
4. Salva report per condivisione commerciale/operativa.

**Screenshot placeholder**
`[SCREENSHOT: modale Export con pulsante Download .xlsx]`

## Troubleshooting rapido
- Non vedi servizi: controlla tenant attivo e filtri.
- Non puoi assegnare: verifica ruolo (`operator`/`admin`) e driver disponibile.
- Export non disponibile: verifica configurazione Supabase/env.

