# Estratti conto agenzie

Il periodo è inclusivo, selezionato per arrivo o partenza dell'intera prenotazione.
Una riga A/R singola conserva il prezzo completo. Due tratte esplicitamente collegate
conservano i rispettivi importi e condividono le date della prenotazione. Nessun
accorpamento per nominativo o numero pratica. Gli invii programmati usano gli arrivi.

Sono fatturabili i servizi non in bozza confermati, o importati con approvazione
legacy non valorizzata. Pending, price mismatch e rifiutati sono esclusi. I cancellati
compaiono esclusivamente per una penale attiva, addebitata una sola volta. Un prezzo
mancante blocca la generazione; zero esplicito è valido. Si usa il prezzo concordato,
poi quello importato. Agenzia risolta per ID o, per righe legacy senza ID, nome esatto
senza differenze di maiuscole/spazi. Alias simili devono essere collegati esplicitamente:
la generazione si ferma anziché ometterli o attribuirli automaticamente.

## Documenti e pagamenti

Numero EC-ANNO-PROGRESSIVO per tenant, assegnato atomicamente, presente in email,
Excel e pannelli. Documenti esistenti numerati per data/ID. Il contatore non viene
riutilizzato dopo una cancellazione. Uno stesso periodo/criterio recupera il documento
esistente senza inviarlo nuovamente. Pratiche già presenti in altri documenti bloccano
un nuovo estratto, anche cambiando periodo o criterio. I duplicati storici non vengono
rimossi automaticamente.

Totale, incassato verificato, abbuoni e residuo sono separati. L'agenzia segnala un
pagamento (data/importo/modalità/riferimento), ITS verifica o rifiuta. La segnalazione
non modifica il saldo. La verifica alloca l'incasso alle righe e aggiorna documento,
pratiche e mastro in una transazione. Gli acconti mantengono il residuo. Pagamenti
ripetuti con la stessa chiave non vengono aggiunti due volte. Le penali hanno un
pagamento separato, senza marcare come saldato il vecchio prezzo della prenotazione.

Il salvataggio storico di un estratto già pagato inizializza gli importi sulle pratiche
non annullate, senza sommare eventuali copie duplicate dello stesso documento.
Controllare il preflight e le discrepanze storiche prima del rilascio: non si correggono
automaticamente documenti annullati o incassi da rimborsare. Non esiste un rimborso
automatico. Correzioni sotto l'incassato richiedono prima la gestione dell'incasso.

## Revisione agenzia

Pannello e link email usano la stessa revisione atomica. Salva bozza persiste tutte
le correzioni senza email e senza modificare i prezzi ufficiali. Il comando finale
invia una sola email per tutto il blocco; un secondo invio concorrente è rifiutato.
Il vecchio POST per singola riga è disabilitato. Approvare l'estratto come corretto
non significa pagarlo. L'approvazione ITS di una correzione aggiorna snapshot e
prezzo della pratica insieme. Le penali richiedono la loro rettifica dedicata.

## Rilascio e validazione

1. Eseguire `supabase/checks/agency_statement_preflight.sql` sul progetto ITS e
   controllare schema, duplicati e anomalie senza cancellare dati.
2. Applicare `supabase/migrations/20261031061147_agency_statement_accounting.sql`.
   RPC security invoker, eseguibili solo da service_role; route controllano tenant,
   ruolo e agenzia/token. RLS limita i documenti all'agenzia proprietaria.
3. Pubblicare applicazione dopo verifica schema/RPC. Non inviare estratti reali come
   test senza scegliere destinatario e documento. Verificare flusso browser completo.

Suite SQL isolata (nessuna connessione di produzione): installare
`@electric-sql/pglite@0.3.14` in una directory temporanea e avviare
`ITS_PGLITE_MODULE=/percorso/node_modules/@electric-sql/pglite/dist/index.js node tests/database/agency-statement-accounting.mjs`.
La suite esercita il vero SQL di migrazione su uno schema ridotto delle colonne
interessate; non sostituisce il preflight sullo schema live completo.
