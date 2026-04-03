# Guida Agenzia

## Obiettivo
Inserire e monitorare prenotazioni visibili all'agenzia nel proprio perimetro tenant.

## Flusso principale
1. Login come `agency`.
2. Inserisci prenotazione da area agenzia.
3. Consulta `Mie Prenotazioni`.
4. Controlla aggiornamenti stato servizio.

## 1) Login e accesso area
1. Apri login e usa account ruolo `agency`.
2. Dopo accesso, vai su `Agency` (`/agency`) o `Mie Prenotazioni` (`/agency/bookings`).
3. Verifica che siano visibili solo prenotazioni consentite.

**Screenshot placeholder**
`[SCREENSHOT: landing area Agency con menu prenotazioni]`

## 2) Inserimento prenotazione
1. Crea nuova richiesta con dati cliente:
   - nome cliente
   - telefono
   - data/ora transfer
   - hotel/zona
   - note viaggio
2. Salva richiesta.
3. Verifica presenza in elenco prenotazioni.

**Screenshot placeholder**
`[SCREENSHOT: form nuova prenotazione agenzia]`

## 3) Monitoraggio stato prenotazioni
1. Apri `Mie Prenotazioni`.
2. Controlla colonne principali:
   - riferimento prenotazione
   - data/ora
   - stato servizio
3. Usa filtri data/stato per ricerca rapida.

**Screenshot placeholder**
`[SCREENSHOT: tabella Mie Prenotazioni con filtri]`

## Note permessi (RBAC/RLS)
- Un utente `agency` non vede dati fuori tenant.
- Visibilita servizi limitata secondo criterio applicato (es. `created_by` o relazione autorizzata).
- Nessun accesso a pannelli operator/dispatch.

