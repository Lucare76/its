# Stato di lavoro — modulo Assegnazioni

## STATO GENERALE: AUDIT COMPLETATO (2026-07-31), NESSUN TASK DI HARDENING ANCORA AVVIATO

- **Branch**: main
- **HEAD al momento dell'audit**: `64bb3eb4c5c6278fde3bc6f8b6bedd34ed600641` (allineato con `origin/main`, verificato con `git rev-parse HEAD`/`git rev-parse origin/main` il 2026-07-31)
- **Worktree iniziale**: pulito (solo cartella non tracciata `exports/`, preesistente, non correlata)
- **Data audit**: 2026-07-31

## Cosa è stato fatto in questa sessione

Audit read-only completo del modulo Assegnazioni tramite 8 sub-agenti paralleli (Architettura/Mappatura, Database/Integrità, Sicurezza/Tenant Isolation, Concorrenza/Lock, Funzionale/Operativo, UI/UX, Test/Performance/Osservabilità, ML/Automazione) + sintesi dell'agente principale. Prodotti i tre documenti richiesti:
- `docs/audits/assignments-module-audit.md` — audit completo, 29 sezioni, finding classificati con evidenza file:riga
- `docs/plans/assignments-hardening-checklist.md` — checklist atomica M1/M1.5/M2
- `docs/plans/assignments-working-status.md` — questo file

**Nessun file applicativo o di test è stato modificato.** Nessuna migrazione creata. Nessun commit, nessun push.

## Finding più urgenti (dettaglio completo in assignments-module-audit.md §24)

| ID | Severità | Titolo |
|---|---|---|
| SEC-01 | CRITICAL | IDOR cross-tenant in `departure-bus-assign` |
| SEC-02 | CRITICAL | IDOR cross-tenant in `piano-giorno/trips` (create_trip/update_trip) |
| CONC-01 | CRITICAL | Errore insert non controllato in `assign-service` → falso successo + trip_groups orfano |
| FUNC-01 | CRITICAL | `departure-bus-assign` privo di qualunque validazione operativa |
| SEC-04 | HIGH | Broken access control orizzontale in `driver-status` |
| CONC-02/03 | HIGH | Nessun vero controllo overlap orario driver/mezzo |
| SEC-03 | HIGH | Join senza filtro tenant esplicito |
| CONC-06 | HIGH | Bulk auto-assign, snapshot non rivalidato al commit |
| TEST-01/TEST-03 | HIGH | Zero test su route più usate, zero suite tenant isolation |

## Verità sul ML (sintesi — dettaglio in audit §18-23)

**Classificazione: EURISTICA** (con vincoli hard tipo sistema a regole). Nessun machine learning reale: zero librerie ML, nessun training, nessun modello persistito. Il "learning" (`assignment_learned_patterns`) è un conteggio di frequenze storiche mappato a bucket hardcoded (±50/±25). Un modulo di scoring alternativo (`lib/dispatch-driver-scoring.ts`) è codice morto, mai collegato a nulla. Esiste una vera chiamata LLM (Claude Haiku, `ai-plan/route.ts`) ma produce solo testo di riepilogo, non integrata nel motore di assegnazione. Guardrail di sicurezza solidi: vincoli hard prima dello scoring, rispetto del lock manuale (`locked_by_operator`), fallback deterministico su errore, filtro tenant sistematico nelle query del sistema di apprendimento (fix storico in migrazione `0203`).

## Task corrente

Nessuno — audit appena chiuso, in attesa di via libera dell'utente per avviare Milestone 1 della checklist.

## Prossimo task raccomandato

**M1-03 (CONC-01)** — è il fix più piccolo (stima XS) e chiude il rischio più concreto e frequente in produzione multi-operatore (falso successo su doppia assegnazione concorrente + trip_groups orfano). In alternativa, se si preferisce chiudere prima i rischi di sicurezza cross-tenant: **M1-01 (SEC-01)** e **M1-02 (SEC-02)**.

## Blocchi

Nessuno. Tutti i finding CRITICAL/HIGH hanno una soluzione minima chiara descritta nell'audit (§24) e un task corrispondente nella checklist.

## Decisioni prese in questa sessione

- Nessuna modifica di codice: solo audit, come da vincolo esplicito dell'utente.
- I tre motori di scoring duplicati (planner globale, dispatch-driver-scoring dead code, fallback greedy) non vengono unificati in M1: è un intervento strutturale rimandato a M2-04.
- Il vincolo DB `EXCLUDE` anti-overlap (M2-01) è rimandato a M2 perché richiede prima una decisione di design sulla rappresentazione temporale dei servizi (oggi fino a 3 coppie data/ora diverse a seconda del tipo di booking).

## Cose da NON modificare

- WhatsApp (template, webhook Meta, invii, convocazioni) — fuori perimetro assoluto.
- `lib/server/piano-driver-swap-preview.ts` — contiene un caso hardcoded specifico ("GPR_PETER", data 2026-05-07); qualunque refactoring di quell'area richiede conferma esplicita che il caso reale non sia più attivo prima di generalizzare/rimuovere.
- Nessun task M1/M1.5 rimuove funzionalità esistente — sono tutti additivi (nuovi controlli) o correzioni di gestione errori.

## Comandi per riprendere da un'altra postazione

```bash
git status --short
git log --oneline -5
cat docs/plans/assignments-working-status.md
cat docs/plans/assignments-hardening-checklist.md
```

Poi partire dal "Prossimo task raccomandato" sopra, seguendo il Definition of Done della checklist.

## Procedura post-task (per ogni futuro task M1/M1.5/M2 completato)

1. Implementare il fix minimo descritto nel finding corrispondente in `assignments-module-audit.md` §24.
2. Aggiungere/estendere test come da Definition of Done.
3. `pnpm typecheck && pnpm lint && pnpm test` puliti.
4. Commit dedicato riferendo l'ID finding.
5. Aggiornare questo file: spuntare il task in checklist, aggiornare "Task corrente"/"Prossimo task", aggiornare HEAD.
6. Non fare push senza conferma esplicita dell'utente.

## Vincolo WhatsApp

Il modulo WhatsApp è operativo in produzione e non deve essere toccato da nessun task di questa checklist. Nessuna delle route di assegnazione analizzate invia notifiche WhatsApp direttamente (le notifiche driver passano da Web Push, non WhatsApp), quindi il rischio di impatto indiretto è basso ma va comunque verificato caso per caso se un task tocca `status_events` (tabella condivisa con eventuali trigger WhatsApp non analizzati in questo audit).
