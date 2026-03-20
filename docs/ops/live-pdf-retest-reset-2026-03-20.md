# PDF Retest Reset - Live First

## Obiettivo
- non considerare piu sufficienti i test locali
- validare ogni formato su ambiente live
- tracciare parser scelto, qualita, review, esito operativo finale

## Procedura
1. caricare il documento in live
2. salvare parser scelto e parsing quality
3. verificare campi chiave:
   - cliente
   - data arrivo
   - data partenza
   - orari
   - hotel / meeting point
   - pax
   - booking kind / service type
4. segnare se serve review manuale
5. confermare solo se il risultato operativo e corretto
6. verificare comparsa nell'operativo del giorno corretto

## Tracciamento minimo
- filename
- famiglia parser
- parser_key
- quality
- review necessaria si/no
- confermato si/no
- operativo visibile si/no
- problemi residui

## Famiglie da ritestare da zero
- Aleste
- Sosandra / Rossella
- Angelino
- Holiday Sud Italia
- Dimhotels / SNAV
- Zigolo Viaggi
- Bus operations

## Regola
- test locale utile solo come pre-check
- esito valido solo dopo verifica live
