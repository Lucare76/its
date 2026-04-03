# Zigolo Viaggi - TSF PER HOTEL ANDATA + RITORNO

File sorgente:
- `tests/pdfs/zigolo/ok/Elenco richieste conferme annullamenti servizi_000042_000001_000001.pdf`

Classificazione:
- famiglia: `Zigolo Viaggi`
- sottotipo: `TSF porto-hotel (andata + ritorno)`
- booking kind: `transfer_port_hotel`
- service type: `transfer_port_hotel`

Risultato atteso in live:
- nome completo: `LATROFA MARIA TERESA` (OCR perde la L → `ATROFA MARIA TERESA`)
- agenzia fatturazione: `Zigolo Viaggi`
- pratica: `26/000227`
- riferimento: `Giuseppe`
- passeggeri: `2`
- costo totale pdf: `13,20`
- valuta: `EUR`
- data andata: `15/03/26`
- data ritorno: `22/03/26`
- booking kind: `transfer_port_hotel`

Casi critici protetti:
- `DESCRIZIONEIMPORTOTASSETOTALE` (senza PAX) — header ANDATA concatenato dall'OCR,
  non gestito dalla normalizzazione precedente (che aveva solo la variante con PAX).
  Fix: aggiunta regola `descrizioneimportotassetotale → descrizione importo tasse totale`
- `Dal15-mar-26` (senza spazio) — OCR concatena `Dal` con la data nell'ANDATA block.
  Fix: normalizzazione `\bdal(?=\d) → dal<space>`
- `TSF PER HOTEL ANdata` — OCR misto maiuscolo/minuscolo. Gestito dal flag `i` del regex.
- `6,60(2)16,60` — OCR concatena `(2) 1 6,60` in `(2)16,60`. pax=(2)=2 ✓
- Costo totale: OCR produce `16,60` dall'artefatto `1 6,60` → fix usa max dei
  `TOTALE EUR` espliciti: max(6,60, 13,20) = 13,20 ✓
- Pax: sempre il numero TRA parentesi (regola Zigolo Viaggi).
  ANDATA `(2)` → 2, RITORNO `(1)` → 1, max = 2 ✓
- `TOTALE EUR↵6,60` — importo su riga separata, gestito da `\s*` nel regex ✓

Note:
- la L di LATROFA viene persa dall'OCR (bordo cella tabella) → non correggibile dal parser
- il campo `date_from` è corretto (2026-03-15) ma il form usa `parsed_services[0].service_date`;
  occorre che il blocco ANDATA matchi per avere il servizio andata come primo elemento
