# Ischia Transfer - Demo Script 5 Minuti

## Obiettivo
Mostrare in modo rapido il valore operativo end-to-end: prenotazione -> ingestione -> dispatch -> driver.

## Sequenza consigliata
1. Apri Dashboard (`/dashboard`) e mostra KPI + Demo Rapida.
2. Vai su Nuova prenotazione agenzia (`/agency/new-booking`):
   - compila i campi principali
   - conferma creazione
3. Vai su Inbox (`/inbox`):
   - carica un PDF manuale
   - mostra draft creato
   - usa "Conferma rapida draft"
4. Vai su Dispatch (`/dispatch`):
   - assegna autista e mezzo
   - mostra stato aggiornato
5. Vai su area Driver (`/driver`):
   - verifica che il servizio assegnato sia visibile

## Messaggi chiave da dire durante la demo
- "Il sistema separa dati per tenant in modo rigoroso."
- "L'operatore riduce tempi con draft automatici da PDF."
- "Il dispatch ha visione immediata su carico operativo."
- "L'app autista riceve solo servizi pertinenti."

## Piano B (se manca un dato live)
- Se mancano hotel: onboarding step 1 + pagina hotel.
- Se inbox è vuota: upload PDF manuale in tempo reale.
- Se manca autista: crea prenotazione e mostra solo flusso operatore.
