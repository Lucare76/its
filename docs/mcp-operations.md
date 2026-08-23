# MCP ITS — Operations

Server MCP locale per ITS: espone tool business-oriented (mai SQL libero) a un client MCP autorizzato, per interrogare la situazione operativa e — con conferma esplicita — eseguire un numero limitato di scritture.

## Come avviare

```bash
ITS_MCP_ACCESS_TOKEN=<supabase-access-token> pnpm exec tsx scripts/mcp-server.ts
```

- `ITS_MCP_ACCESS_TOKEN` — access token Supabase di un utente reale già loggato nell'app (obbligatorio). Identità, tenant e ruolo sono risolti server-side da questo token prima di avviare il transport.
- `ITS_MCP_TENANT_ID` — opzionale, per scegliere tra le membership dell'utente se ne ha più di una.

Env richieste (stesse della webapp): `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `AGENCY_ACTION_SECRET` (firma i confirmation token WRITE).

## Transport

Solo **stdio**, per client locali/controllati (es. Claude Desktop, Claude Code). Nessun endpoint pubblico su Internet, nessun SSE/HTTP pubblico, nessun deploy su Vercel in questo sprint.

## Tool disponibili

### READ

| Tool | Scopo |
|---|---|
| `its.get_operational_brief` | Quadro sintetico della giornata: servizi, non assegnati, salute generale. |
| `its.get_health_status` | Job Health + Operational Health — stessa source of truth di `/settings/system`. |
| `its.get_operational_alerts` | Elenco di cosa richiede attenzione (critical/warning), con eventuale link già determinato. |
| `its.get_unassigned_services` | Servizi di una giornata che richiedono ancora un autista (stessa logica di assegnabilità del Piano del Giorno). |
| `its.get_day_plan` | Vista compatta del giorno: servizi, assegnazioni, autisti in servizio. |
| `its.get_driver_availability` | Autisti attivi e i loro slot già occupati per una data. |
| `its.get_fleet_status` | Mezzi attivi/inattivi ed eventuale blocco manuale. |
| `its.search_services` | Ricerca servizi per intervallo date/stato/testo. |
| `its.get_service` | Dettaglio di un singolo servizio. |
| `its.preview_assign_driver` | Anteprima READ-only di un'assegnazione (produce un confirmation token). |
| `its.preview_update_service_status` | Anteprima READ-only di un cambio stato (produce un confirmation token). |

### WRITE

| Tool | Scopo |
|---|---|
| `its.assign_driver` | Esegue un'assegnazione precedentemente approvata via `its.preview_assign_driver`. |
| `its.update_service_status` | Esegue un cambio stato precedentemente approvato via `its.preview_update_service_status`. |

## Regola preview → confirmation → execute

Ogni WRITE segue sempre: **preview** (READ-only, restituisce un confirmation token se l'azione è eseguibile) → **conferma umana** (il client mostra cosa succederà) → **execute** (accetta *solo* il confirmation token, mai i parametri originali). Il token è firmato HMAC, TTL breve, single-use, legato a user/tenant/payload, e l'esecuzione rivalida sempre lo stato live prima di scrivere.

## Limitazioni

- Solo transport locale (stdio) — nessun accesso remoto in questo sprint.
- Ruoli ammessi per i tool operativi: `admin`, `operator`, `supervisor` (mai `driver`/`agency`).
- Nessun SQL arbitrario, nessun table browser: solo i tool elencati sopra.

## Esempi di domande operative

- "Come siamo messi oggi?" → `its.get_operational_brief`
- "C'è qualcosa che richiede attenzione?" → `its.get_operational_alerts`
- "ITS sta funzionando bene?" → `its.get_health_status`
- "Chi è disponibile questo pomeriggio?" → `its.get_driver_availability`
- "Mostrami i servizi senza autista" → `its.get_unassigned_services` (o `its.get_day_plan` per la vista completa)
- "Assegna Mario Rossi al servizio X" → `its.preview_assign_driver` poi, dopo conferma, `its.assign_driver`

## Mario Interface

Interfaccia web one-shot (testo + voce) che traduce una domanda in linguaggio naturale in una chiamata a UN tool MCP READ, tramite la stessa pipeline `runTool` (policy → rate limit → validazione → handler → audit) usata dal transport stdio — nessuna seconda logica, nessun server MCP avviato dentro la route.

- **Route:** `/mario-assistant` (pagina) + `POST /api/mario-assistant` (endpoint interno, sessione ITS esistente — nessun token MCP separato).
- **Ruoli ammessi:** `admin`, `operator`, `supervisor` (mai `driver`/`agency`) — 401 se non autenticato, 403 se ruolo non ammesso.
- **Intent supportati** (parser deterministico, nessun LLM — `lib/server/mario-assistant/intent-parser.ts`):
  | Intent | Esempi | Tool chiamato |
  |---|---|---|
  | `operational_brief` | "Come siamo messi oggi?" | `its.get_operational_brief` |
  | `health_status` | "ITS sta funzionando bene?" | `its.get_health_status` |
  | `alerts` | "Cosa richiede attenzione?" | `its.get_operational_alerts` |
  | `unassigned` | "Servizi senza autista" | `its.get_unassigned_services` |
  | `driver_availability` | "Chi è disponibile questo pomeriggio?" | `its.get_driver_availability` |
- Una richiesta che sembra una modifica ("assegna", "cambia stato", …) non viene mai eseguita: risposta fissa che rimanda al flusso preview/confirm MCP esistente.
- Un testo non riconosciuto restituisce un messaggio di aiuto, mai un guess.
- **Voce browser:** Web Speech API (`SpeechRecognition`/`webkitSpeechRecognition`) lato client, nessun servizio speech-to-text esterno. Se non supportata dal browser, fallback chiaro e il campo testo resta l'unico modo di inviare la domanda.
- **Solo READ:** nessun nuovo WRITE raggiungibile da questa interfaccia in questo sprint.
- **Nessun accesso remoto MCP diretto:** la Mario Interface non espone il transport MCP — chiama `runTool` in-process, il transport stdio resta invariato e locale.
