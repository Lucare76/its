# Progetto CMS Ischia Transfer – Versione Ottimizzata (Budget Zero)

Documento operativo aggiornato con approccio pragmatico per realizzare e scalare il sistema spendendo zero o quasi, usando strumenti gratuiti, automazioni semplici e componenti già disponibili.

## Obiettivo
- Centralizzare tutte le prenotazioni transfer
- Ridurre caos tra email e WhatsApp
- Automatizzare dispatch e contabilità
- Permettere alle agenzie di prenotare online

## Strumenti gratuiti consigliati
- Backend: **Supabase** o **Firebase** (free tier)
- Database hotel: **Google Sheets**
- Mappe: **OpenStreetMap**
- Automazioni email: **Make** / **Zapier** (free tier)
- Hosting: **Vercel** o **Netlify**
- Login utenti: **Supabase Auth**

## Funzioni principali
- Import automatico email prenotazioni
- Dashboard servizi da validare
- Assegnazione automatica mezzi
- Mappa hotel e percorsi
- Conferme automatiche email / WhatsApp

## Area agenzie
- Login
- Creazione prenotazione
- Storico servizi
- Download fatture

## App autisti (versione semplice)
- Web app mobile
- Lista servizi assegnati
- Pulsanti stato servizio (es. partito / arrivato / completato)
- Navigazione tramite Google Maps

## Automazioni intelligenti
- Raggruppamento clienti per nave
- Ordine hotel per zona
- Suggerimento mezzi
- Report automatici settimanali

## Statistiche utili
- Hotel che generano più clienti
- Giorni con più arrivi
- Fatturato settimanale
- Performance mezzi

## Possibile evoluzione
- Vendita software ad altre agenzie
- Versione SaaS multi-cliente
- App autisti completa
- Integrazione voli e treni

## Allineamento con lo stato attuale del progetto
Nel codice corrente sono già presenti basi solide per il piano:
- Backend Node/Express con ruoli agenzia/operatore
- Dashboard operativa con validazioni, KPI, dispatch e contabilità
- Raggruppamento arrivi e geolocalizzazione hotel
- Export/import dati e automazioni operative principali
- Backup giornaliero automatico database con retention configurabile

## Piano pratico a costo zero (prossimi step)
1. Completare ingest email low-cost (IMAP + parser) verso “Da validare”
2. Aggiungere automazione messaggi conferma (email subito, WhatsApp in seconda fase)
3. Creare web app autisti minimale con autenticazione e stati servizio
4. Definire dashboard statistiche settimanali per hotel/arrivi/fatturato/mezzi
5. Preparare struttura multi-tenant leggera per futura versione SaaS

## Backlog operativo (Sprint 1-2-3)

Legenda priorità: P0 = blocca il valore business, P1 = molto importante, P2 = miglioramento.
Legenda effort: S = 0.5-1 giorno, M = 2-3 giorni, L = 4-6 giorni.

### Sprint 1 (MVP operativo) — durata consigliata: 2 settimane

Obiettivo sprint: portare a regime il flusso richiesta → validazione → dispatch con affidabilità e routine giornaliera.

1. P0 | M | Inbox email a Da validare
	- Implementare lettura mailbox dedicata (IMAP) con polling schedulato
	- Estrarre campi minimi da email e allegati (mittente, servizio, pax, data/ora, riferimento viaggio)
	- Creare prenotazioni in stato PENDING con tracciamento origine
	- Dipendenze: account email operativo
	- Done quando: nuove email valide compaiono automaticamente nella dashboard da validare

2. P0 | S | Hardening validazione operatore
	- Migliorare feedback errori in validazione/approvazione
	- Bloccare in modo esplicito duplicati semplici (stesso riferimento + orario ravvicinato)
	- Done quando: l’operatore non perde richieste e capisce sempre perché un record fallisce

3. P0 | S | Routine backup e ripristino
	- Verifica giornaliera backup automatico già attivo
	- Aggiungere mini procedura di restore testata in ambiente locale
	- Done quando: esiste procedura scritta e provata per ripristinare database da backup

4. P1 | M | Home giornaliera colpo d’occhio
	- Consolidare KPI giornata (arrivi, partenze, pendenti, notifiche)
	- Evidenziare anomalie (picchi pendenti, servizi senza dispatch)
	- Done quando: in meno di 30 secondi l’operatore vede la situazione del giorno

### Sprint 2 (automazioni e autisti) — durata consigliata: 2 settimane

Obiettivo sprint: ridurre lavoro manuale su comunicazioni e avanzamento servizi.

1. P0 | M | Web app autisti minimale
	- Vista mobile con login autista
	- Lista servizi assegnati per giornata
	- Stati servizio (assegnato, in corso, completato)
	- Pulsante apri navigazione su Google Maps
	- Done quando: almeno un autista riesce a gestire una giornata senza supporto operativo continuo

2. P0 | M | Conferme automatiche cliente/agenzia
	- Trigger su prenotazione approvata e su dispatch creato
	- Template messaggio standard con campi dinamici
	- Canale email immediato, WhatsApp in seconda fase
	- Done quando: ogni approvazione genera conferma senza invio manuale

3. P1 | S | Raggruppamento intelligente nave/treno
	- Affinare finestra temporale e suggerimento mezzi
	- Logica semplice di priorità per collettivo vs privato
	- Done quando: l’operatore riduce tempi di pianificazione nelle fasce di picco

4. P1 | S | Qualità dati hotel
	- Normalizzazione nomi hotel duplicati
	- Aggiornamento coordinate mancanti da OpenStreetMap
	- Done quando: percorsi e ordinamenti fermate risultano stabili

### Sprint 3 (contabilità e reporting) — durata consigliata: 2 settimane

Obiettivo sprint: controllo economico settimanale e base per scalabilità commerciale.

1. P0 | M | Dashboard statistiche settimanali
	- Hotel top per volume clienti
	- Giorni con più arrivi
	- Fatturato settimanale
	- Utilizzo/performance mezzi
	- Done quando: l’owner ha report decisionale settimanale senza export manuali complessi

2. P1 | M | Area agenzie evoluta
	- Storico avanzato servizi con filtri
	- Download fatture/estratti pertinenti
	- Done quando: le richieste amministrative ricorrenti via email diminuiscono sensibilmente

3. P1 | S | KPI qualità operativa
	- Tempo medio validazione richiesta
	- Percentuale servizi pianificati entro soglia
	- Errori/ritorni per dati incompleti
	- Done quando: team e owner vedono trend affidabilità operativa

4. P2 | M | Pre-SaaS readiness
	- Separazione configurazioni per cliente
	- Baseline multi-tenant leggera (branding e parametri)
	- Done quando: il prodotto è presentabile a una seconda agenzia pilota

## Milestone di controllo
- Fine Sprint 1: zero richieste perse, flusso operativo stabile, backup verificato
- Fine Sprint 2: autisti operativi via web app, conferme automatizzate
- Fine Sprint 3: reporting economico completo e base pronta per scalare

## Rischi principali e mitigazioni
- Parsing email non uniforme → usare fallback manuale assistito e template mittenti ricorrenti
- Dati incompleti agenzia → validazioni obbligatorie su campi minimi prima della conferma
- Adozione autisti lenta → UX ultra-semplice e formazione di 30 minuti con checklist
- Carico operativo stagionale → monitor KPI giornalieri e soglie di allerta pendenti