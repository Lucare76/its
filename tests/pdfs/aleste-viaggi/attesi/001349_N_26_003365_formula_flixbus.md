# Aleste Formula Flixbus - Caso Protetto

File sorgente:
- `tests/pdfs/aleste-viaggi/ok/CONFERMA D'ORDINE n. 001349_N_26_003365_1_000001.pdf`

Classificazione:
- famiglia: `Aleste Viaggi`
- sottotipo: `formula Flixbus`
- booking kind: `transfer_train_hotel`
- service type: `transfer_station_hotel`

Risultato atteso in live:
- nome completo: `BRANCHESI PAOLO`
- agenzia fatturazione: `Aleste Viaggi`
- telefono: `3338379245`
- data andata: `14/03/26`
- orario andata: `13:00`
- data ritorno: `21/03/26`
- orario ritorno: `13:15`
- meeting point: `STAZIONE`
- hotel / destinazione: `ISOLA VERDE HOTEL & THERMAL SPA`
- passeggeri: `2`
- costo totale pdf: `104.00`
- costo pdf per pax: `52.00`
- valuta: `EUR`
- riferimento mezzo andata: `FLIXBUS 556`
- riferimento mezzo ritorno: `FLIXBUS 556`

Note di protezione:
- questo PDF e' un caso protetto
- Flixbus va trattato come `transfer stazione / hotel`
- per l'andata l'orario corretto e' quello dopo `Alle`
- non deve essere riclassificato come `bus_line`
