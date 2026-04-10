# Stack Ufficiale (Fonte di verità)

Data: 10/03/2026

## Decisione architetturale
- La base ufficiale del progetto Ischia Transfer è **solo** il ramo applicativo **Next.js + Supabase** in root repository.
- I percorsi `server/` e `client/` sono **legacy congelato** (read-only), fuori dal perimetro di evoluzione.

## Perimetro ufficiale
- Frontend/App/API: `app/`, `components/`, `lib/`
- Database e sicurezza: `supabase/migrations/`, RLS Supabase
- Tooling ufficiale: `pnpm lint`, `pnpm build`, `pnpm e2e`

## Perimetro legacy (non ufficiale)
- `server/` (Express + Prisma + SQLite)
- `client/` (React + Vite)

## Regole operative
- Nessuna nuova feature o fix business nei path legacy.
- Nessun deploy o CI gate basato su codice legacy.
- Eventuali consultazioni legacy solo a scopo storico/forense.
