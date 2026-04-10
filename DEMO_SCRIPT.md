# DEMO SCRIPT (5 minuti)

## 0:00 - 0:30 | Home pubblica (landing)
- Apri `/`
- Pitch: "Piattaforma transfer multi-tenant per agenzie, operatori e driver."
- Evidenzia CTA `Accedi` e passaggio immediato all'operativita.

## 0:30 - 0:50 | Login operatore
- Apri `/login`
- Seleziona ruolo `operator` e accedi.

## 0:50 - 1:50 | Dashboard oggi
- Apri `/dashboard`
- Mostra:
  - KPI
  - filtri (stato; per demo cita anche nave/zona come estensione pronta)
  - click su un servizio -> drawer dettagli + timeline eventi

## 1:50 - 2:30 | Crea prenotazione (vista Agenzia)
- Apri `/agency`
- Inserisci nuova prenotazione e conferma.
- Torna in dashboard e mostra il servizio in stato `new` / "Da assegnare".

## 2:30 - 3:00 | Dispatch / assegnazione
- Apri `/dispatch`
- Assegna driver + mezzo al servizio appena creato.

## 3:00 - 3:30 | Mappa operativa
- Apri `/map`
- Applica filtri e layer.
- Mostra hotel (cluster) + servizi di oggi sulla mappa.

## 3:30 - 4:20 | Driver flow
- Vai su `/login`, seleziona ruolo `driver`.
- Apri `/driver`, entra nel dettaglio servizio.
- Aggiorna stato: `PARTITO` -> `ARRIVATO` -> `COMPLETATO`.
- Torna su dashboard operatore e mostra stato aggiornato.

## 4:20 - 5:00 | Email ingestion WOW
- Apri `/ingestion`.
- Opzione A: invia `POST /api/email/inbound` con token.
- Opzione B: usa inbox demo e premi `Converti`.
- Mostra che l'email viene convertita in servizio operativo.
