# Aleste Formula Medmar Napoli - TRAGHETTO NAPOLI + TRS H. ISCHIA

File sorgente:
- `tests/pdfs/aleste-viaggi/ok/CONFERMA D'ORDINE n. 001274_N_26_003114_1_000005.pdf`

Classificazione:
- famiglia: `Aleste Viaggi`
- sottotipo: `formula Medmar da Napoli (traghetto)`
- booking kind: `transfer_ferry_hotel`
- service type: `transfer_station_hotel`

Risultato atteso in live:
- nome completo: `MARCHIONNA FILOMENA`
- agenzia fatturazione: `Aleste Viaggi`
- telefono: `3460244048`
- hotel / destinazione: `AV TERME COLELLA`
- passeggeri: `2`
- costo totale pdf: `50,00`
- costo pdf per pax: `25,00`
- valuta: `EUR`
- data andata: `31/05/26`
- orario andata: `14:20`
- meeting point andata: `PORTO DI NAPOLI PORTA DI MASSA`
- data ritorno: `04/06/26`
- orario ritorno: `10:35`
- meeting point ritorno: `AV TERME COLELLA`
- vettore: `MEDMAR`
- label andata: `TRAGHETTO NAPOLI + TRS H. ISCHIA`
- label ritorno: `TRS H. ISCHIA + TRAGHETTO NAPOLI`

Casi critici protetti:
- `fromDestination` in `extractHotel`: il lookahead era `\s+Il[0-3]?\d-` senza spazio tra
  `Il` e la data, falliva su `Il 04-giu-26` e catturava `PORTO DI NAPOLI` dal secondo dest:
  invece di `AV TERME COLELLA` dal primo — fix: aggiunto `\s*` tra `Il` e il digit
- `extractAlesteMarineJourney` non aveva pattern per `TRAGHETTO NAPOLI + TRS H. ISCHIA`
  con `NAPOLI CON MEDMAR` (solo Pozzuoli e SNAV erano gestiti)
- label marine mostravano "POZZUOLI" anche per MEDMAR da Napoli

Note:
- il campo `a:` dell'andata contiene `CELL: 3460244048` (telefono inline), non un porto
- `hotel / destinazione` deve essere `AV TERME COLELLA`, mai `PORTO DI NAPOLI` o `TRANSFER`
- non deve essere degradato da fix su formule SNAV, Pozzuoli o Frecciarossa
