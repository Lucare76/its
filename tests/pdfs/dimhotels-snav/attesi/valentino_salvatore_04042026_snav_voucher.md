# Dimhotels/Snav Voucher - ALISCAFO + TRANSFER HOTEL (andata + ritorno)

File sorgente:
- `tests/pdfs/dimhotels-snav/ok/voucher-snav-2025 1 (11)VALENTINO.pdf`

Classificazione:
- famiglia: `Dimhotels / Snav Voucher` (agenzia reale: Sosandra Tour)
- booking kind: `transfer_port_hotel`
- service type: `transfer_port_hotel`

Risultato atteso in live:
- nome completo: `Salvatore Valentino`
- ns_reference: `DIMHOTELS`
- telefono: `3761931342`
- hotel / destinazione: `Hotel Terme President`
- passeggeri: `2`
- costo totale pdf: `70` (€35 A/R × 2 pax)
- costo per pax: `35`
- valuta: `EUR`
- data andata: `04/04/2026` → `2026-04-04`
- orario andata: `08:25` (Napoli Beverello → Casamicciola)
- data ritorno: `07/04/2026` → `2026-04-07`
- orario ritorno: `09:45` (Casamicciola → Napoli Beverello)
- vettore: `SNAV`
- label andata: `ALISCAFO + TRANSFER HOTEL`
- label ritorno: `TRANSFER HOTEL + ALISCAFO`

Casi critici protetti:
- `total_amount_practice` era hardcoded a €55; fix usa
  `€\s*(\d+)\s*A\/R\s*a\s*persona` × pax → 35 × 2 = 70 ✓
- `parseChosenVoucherTimes`: il segno di spunta (checkbox arancione) viene
  rilevato come marcatore non-standard davanti all'orario → 08:25 andata, 09:45 ritorno ✓
- `Nome: Salvatore` / `Cognome: Valentino` — il parser legge inline dai label ✓

Note:
- Dimhotels = Sosandra Tour (stesso soggetto, brand diverso sul voucher)
- La riga `Tutte le corse sono da intendersi "via Procida"` non altera parsing ✓
- Le corse SNAV passano via Procida ma non impatta l'estrazione dei dati
