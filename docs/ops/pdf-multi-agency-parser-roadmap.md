# PDF Multi-Agenzia - Base Architetturale

## Hook parser per agenzia
Registry introdotta in:
- `lib/server/agency-pdf-parser-registry.ts`

Punti di aggancio attivi:
- `server/email/test-import.ts`
- `app/api/inbound/email/route.ts` (metadata parser in `parsed_json.pdf_parser`)
- `app/api/email/import-pdf/route.ts` (metadata parser in `parsed_json.pdf_parser`)

Parser corrente:
- parser reale unico: `parseTransferBookingPdfText`.
- chiavi parser predisposte per 5 agenzie:
- `agency_alpha`
- `agency_beta`
- `agency_gamma`
- `agency_delta`
- `agency_epsilon`
- fallback: `agency_default`

## Idempotenza practice_number
Stato attuale:
- ricerca pratica su marker note: `[practice:NN/NNNNNN]`.
- se pratica gia presente, riuso `service_id` esistente.
- non vengono creati `status_events` o `assignments` nella pipeline inbound/pdf automatica.

Garanzie operative:
- no duplicazione servizio per stessa pratica (quando marker disponibile).
- no duplicazione status event (pipeline ingestion non li crea).
- no duplicazione assegnazioni (pipeline ingestion non ne crea).

## Piano implementazione parser per 5 agenzie
1. Definire fingerprint per agenzia:
- domini mittente
- pattern subject
- pattern filename PDF
- keyword layout nel testo estratto
2. Per ogni agenzia creare parser dedicato:
- `parseAgencyAlphaPdfText`, ecc.
3. Agganciare parser dedicati nella registry.
4. Aggiungere metrica confidenza parser e fallback controllato su `agency_default`.
5. Test dataset per ogni agenzia:
- almeno 20 PDF reali anonimizzati per layout.
6. KPI minimi:
- precisione estrazione pratica >= 99%
- idempotenza pratica 100%
- mismatch parser < 2%

## Gap residui
- parser dedicati non ancora implementati (solo base registry + fallback).
- fingerprint agenzie da definire con campioni PDF reali.
- test automatici parser-specific non ancora presenti.
