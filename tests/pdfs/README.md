# Archivio PDF Agenzie

Questa cartella serve per raccogliere i PDF reali usati per testare i parser agenzia.

Struttura consigliata:

- una cartella per ogni agenzia
- una sottocartella `ok` per i PDF gia gestiti bene
- una sottocartella `problematici` per i casi ancora da correggere
- una sottocartella `ocr-rumorosi` per scansioni sporche o difficili
- una sottocartella `attesi` per note, screenshot o file `.md` con i risultati attesi

Esempio:

- `tests/pdfs/angelino-tour/ok`
- `tests/pdfs/angelino-tour/problematici`
- `tests/pdfs/angelino-tour/ocr-rumorosi`
- `tests/pdfs/angelino-tour/attesi`

Regole pratiche:

- non committare PDF con dati sensibili se non sono stati anonimizzati
- usa nomi file chiari e stabili
- per ogni PDF problematico aggiungi una nota in `attesi/README.md`
- se un parser viene corretto, sposta il PDF da `problematici` a `ok`
