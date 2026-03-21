# Aleste Formula Frecciarossa - Caso Protetto

File sorgente:
- `tests/pdfs/aleste-viaggi/ok/CONFERMA D'ORDINE n. 001718_N_26_004191_1_000003.pdf`

Classificazione:
- famiglia: `Aleste Viaggi`
- sottotipo: `formula Frecciarossa (treno)`
- booking kind: `transfer_train_hotel`
- service type: `transfer_station_hotel`

Risultato atteso in live:
- nome completo: `PASINA NADIA`
- agenzia fatturazione: `Aleste Viaggi`
- telefono: `3475460581`
- hotel / destinazione: `ISOLA VERDE`
- passeggeri: `4`
- costo totale pdf: `208.00`
- costo pdf per pax: `52.00`
- valuta: `EUR`
- data andata: `14/06/26`
- orario andata: `15:13`
- treno andata: `FRECCIAROSSA 9527`
- meeting point andata: `MILANO`
- destinazione andata: `STAZIONE DI NAPOLI`
- orario arrivo andata: (assente nel PDF)
- data ritorno: `21/06/26`
- orario ritorno: `11:30`
- treno ritorno: `FRECCIAROSSA 9634`
- meeting point ritorno: `ISOLA VERDE`
- destinazione ritorno: `STAZIONE DI NAPOLI`

Casi critici protetti:
- il blocco andata NON ha il campo `Alle [orario]` (orario arrivo assente): la regex deve accettarlo come opzionale
- il campo `a:` del blocco andata contiene `CELL. 3475460581` con il PUNTO (non i due punti): la regex deve accettare `CELL.` oltre a `CELL:`
- il blocco ritorno ha `TRANSFER HOTEL ISCHIA / STAZIONE` (con `ISCHIA`): la regex deve accettare questa variante
- il blocco ritorno NON ha il campo `a:`: la destinazione e' in `dest: STAZIONE DI NAPOLI`
- il PDF contiene `AUTO ISCHIA/HOTEL` nella tabella servizi, il che triggerava falsamente `hasMarineAutoTransfer`: dopo il fix, `hasTrainTransfer` ha priorita' e la classificazione e' corretta (`transfer_station_hotel`)

Note di protezione:
- non deve essere classificato come `transfer_port_hotel` (era il bug pre-fix commit 66f3795)
- non deve essere degradato da fix su `Aleste Medmar`, `Aleste SNAV` o `Aleste bus`
- entrambi i servizi (andata E ritorno) devono essere creati
- il telefono estratto da `Cellulare/Tel. 3475460581` deve essere `3475460581` (senza prefisso `Tel.`)
