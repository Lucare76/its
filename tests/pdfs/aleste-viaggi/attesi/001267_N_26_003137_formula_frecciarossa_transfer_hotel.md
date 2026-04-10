# Aleste Formula Frecciarossa - extractHotel TRANSFER Bug

File sorgente:
- `tests/pdfs/aleste-viaggi/ok/CONFERMA D'ORDINE n. 001267 (o simile).pdf`

Classificazione:
- famiglia: `Aleste Viaggi`
- sottotipo: `formula Frecciarossa (treno)`
- booking kind: `transfer_train_hotel`
- service type: `transfer_station_hotel`

Risultato atteso in live:
- nome completo: `PICCOLI MARIA`
- agenzia fatturazione: `Aleste Viaggi`
- telefono: `3402210398`
- hotel / destinazione: `LA VILLA`
- passeggeri: `1`
- costo totale pdf: `52.00`
- costo pdf per pax: `52.00`
- valuta: `EUR`
- data andata: `10/05/26`
- orario andata: `13:10`
- treno andata: `FRECCIAROSSA 9613`
- meeting point andata: `MILANO`
- data ritorno: `15/05/26`
- orario ritorno: `14:30`
- treno ritorno: `FRECCIAROSSA 9646`
- meeting point ritorno: `LA VILLA`

Caso critico protetto:
- la riga PROGRAMMA contiene `STAZIONE/HOTEL TRANSFER [date] [date]`: `fromAlesteProgramRow` catturava la parola `TRANSFER` e la restituiva come nome hotel
- il filtro esistente controllava solo `PACCHETTO TRANSFER`, non il semplice `TRANSFER`
- `extractHotel()` restituiva `"TRANSFER"` (stringa truthy), bloccando la catena `hotel ?? arrivalTrain?.hotel ?? departureTrain?.hotel`
- `arrivalTrain.hotel` e `departureTrain.hotel` erano entrambi `LA VILLA` ma non venivano mai raggiunti
- fix (commit ec60c8a): aggiunto `!/^TRANSFER\b/i.test(fromAlesteProgramRow)` al guard di `fromAlesteProgramRow`

Note di protezione:
- `hotel_or_destination` deve essere `LA VILLA`, MAI `TRANSFER`
- `eff=TRANSFER` nel debug indica esattamente questo bug: `hotel` truthy ma sbagliato
- non deve essere degradato da fix su `Aleste SNAV`, `Aleste Medmar` o `Aleste bus`
- entrambi i servizi (andata E ritorno) devono essere creati
