# AGENTS

## Obiettivo
Realizzare una Beta vendibile Ischia Transfer con:
- Frontend: Next.js App Router + TypeScript strict + Tailwind + pnpm
- Backend: Supabase Free (Auth + Postgres + RLS)
- Deploy: Vercel Free
- Mappe: Leaflet + OpenStreetMap

## Regole operative
- No segreti nel repository.
- Solo `.env.local` in locale, mai committare chiavi reali.
- Validation payload/form con `zod`.
- Multi-tenant rigoroso: `tenant_id` su ogni tabella dati business.
- RLS attiva e testata in Supabase.

## Ruoli
- `admin`
- `operator`
- `driver`
- `agency`

## Definition of Done
- `pnpm lint` ok
- `pnpm build` ok
- Schema + RLS + seed funzionanti
- UI responsive (driver mobile-first)
- Demo script pronto per presentazione commerciale
