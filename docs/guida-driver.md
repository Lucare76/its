# Guida Driver (mobile-first)

## Obiettivo
Gestire i servizi assegnati, aggiornare stato corsa e usare quick actions (chiama/naviga).

## Flusso principale
1. Login come `driver`.
2. Apri `Driver` (`/driver`).
3. Seleziona servizio in focus.
4. Usa i pulsanti stato:
   - `Partito`
   - `Arrivato`
   - `Completato`
   - `Problema`
5. Usa `Chiama cliente` e `Apri navigazione` quando necessario.

## 1) Vista servizi assegnati
1. Entra nella pagina `Driver`.
2. Controlla card servizio in focus e lista "Other assigned services".
3. Se hai piu servizi, tocca quello da gestire.

**Screenshot placeholder**
`[SCREENSHOT: Driver page mobile con card servizio e pulsanti stato]`

## 2) Aggiornamento stato corsa
1. Premi il pulsante stato corretto.
2. Il sistema aggiorna:
   - `services.status`
   - `status_events` (timeline evento)
3. Verifica badge aggiornato nel servizio.

**Screenshot placeholder**
`[SCREENSHOT: badge stato aggiornato dopo click Partito]`

## 3) Quick actions
1. `Chiama cliente`: apre app telefono (`tel:`).
2. `Apri navigazione`: apre Google Maps con destinazione hotel/meeting point.
3. `Dettagli`: apre scheda completa servizio.

**Screenshot placeholder**
`[SCREENSHOT: quick actions in basso card servizio]`

## Offline e sincronizzazione
- Se la rete cade, l'azione stato viene messa in coda locale.
- Al ritorno online, la coda viene sincronizzata.
- Controlla indicatore `online/offline` e contatore azioni in coda.

## Regole sicurezza (RLS)
- Il driver puo modificare solo servizi assegnati a lui.
- Non puo cambiare servizi di altri driver.
- Non puo leggere dati fuori tenant.

