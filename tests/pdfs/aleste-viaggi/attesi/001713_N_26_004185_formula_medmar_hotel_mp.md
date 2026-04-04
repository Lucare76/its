# Aleste Formula Medmar - Meeting Point = Nome Hotel

File sorgente:
- `tests/pdfs/aleste-viaggi/ok/CONFERMA D'ORDINE n. 001713_N_26_004185_1_000007.pdf`

Classificazione:
- famiglia: `Aleste Viaggi`
- sottotipo: `formula Medmar`
- booking kind: `transfer_port_hotel`
- service type: `transfer_port_hotel`

Risultato atteso in live:
- nome completo: `PERRONE SONIA`
- agenzia fatturazione: `Aleste Viaggi`
- telefono: (assente nel PDF)
- data andata: `30/05/26`
- orario andata: `09:40`
- data ritorno: `02/06/26`
- orario ritorno: `11:10`
- meeting point andata: `PORTO DI POZZUOLI`
- meeting point ritorno: `LA VILLA`
- hotel / destinazione: `LA VILLA`
- passeggeri: `4`
- costo totale pdf: `100.00`
- costo pdf per pax: `25.00`
- valuta: `EUR`

Caso critico protetto:
- nel blocco di andata il campo `a:` contiene `CELL 3314003652` (numero telefono) invece del nome hotel
- l'hotel deve essere estratto da `dest: LA VILLA`, non dal campo `a:`
- nel blocco di ritorno il campo `M.p.:` contiene `LA VILLA` (nome reale dell'hotel), NON la stringa generica `HOTEL ISCHIA`
- prima del fix (commit 7bb1075) il ritorno non veniva parsato perche' la regex cercava letteralmente `HOTEL ISCHIA`
- entrambi i servizi (andata E ritorno) devono essere creati

Note di protezione:
- non deve essere degradato da fix su `Aleste treno`, `Aleste bus` o `Aleste aeroporto`
- l'hotel `LA VILLA` nel meeting point del ritorno non deve mai essere scartato o ignorato
- il ritorno deve restare separato dall'andata
- la regex del ritorno deve accettare qualsiasi nome hotel come M.p., non solo `HOTEL ISCHIA`
