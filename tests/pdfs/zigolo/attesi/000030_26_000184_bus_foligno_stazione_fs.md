# Zigolo Viaggi - BUS DA FOLIGNO STAZIONE FS (andata)

File sorgente:
- `tests/pdfs/zigolo/ok/ELENCO RICHIESTE CONFERME ANNULLAMENTI SERVIZI n. 000030.pdf`

Classificazione:
- famiglia: `Zigolo Viaggi`
- sottotipo: `bus da città (stazione FS)`
- booking kind: `bus_city_hotel`
- service type: `bus_line`

Risultato atteso in live:
- nome completo: `REALI LORELLA`
- ns_reference: `PIETRO CALISE`
- pratica: `26/000184`
- passeggeri: `3`
- costo totale pdf: `127,50`
- costo per pax: `42,50`
- valuta: `EUR`
- data andata: `10/05/26`
- orario andata: `05:45`
- origine: `FOLIGNO`
- destinazione: `HOTEL ISCHIA`
- descrizione riga: `BUS DA FOLIGNO STAZIONE FS 5:45`
- vettore: `BUS`

Casi critici protetti:
- `parseBusTransferBlocks` usava `\s+` tra i campi del totale, ma nel PDF i valori
  della riga tabella sono concatenati senza spazi: `5:4542,503(1)127,50`
  (ora estratti con regex dedicata: `(\d{1,2}[.:]\d{2})(\d+[.,]\d{2})(\d+)\s*\(\d+\)\s*(\d+[.,]\d{2})`)
- i nomi beneficiari (`REALI LORELLA`, `ROLDINI CRISTINA`, `BEDDINI LAURA`) appaiono
  nella sezione intestazione servizio (dopo `001`), NON nel blocco tabella
- l'intestazione della tabella `DAL AL DESCRIZIONEIMPORTOTASSEPAXTOTALE` è concatenata
  senza spazi — `normalizeZigoloText` ora la normalizza

Note:
- `ns_reference` = `PIETRO CALISE` (campo `Ref.` della pratica, non il beneficiario)
- il beneficiario principale è `REALI LORELLA` (prima della lista nella riga 001)
- solo blocco andata (non c'è servizio ritorno in questo PDF)
- `date_to` coincide con `date_from` (`10/05/26`) per assenza ritorno
