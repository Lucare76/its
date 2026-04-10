# PLANS - Beta Vendibile (7 Step)

## Step 1 - Setup
- Next.js App Router + TypeScript + Tailwind + pnpm
- Layout base + routing

## Step 2 - Supabase
- Schema DB con `tenant_id`
- Migrations SQL
- RLS multi-tenant
- Seed demo realistico

## Step 3 - Auth + RBAC
- Login Supabase
- Ruoli: admin/operator/driver/agency
- Protezione route per ruolo

## Step 4 - Web Operatore + Agenzia
- Dashboard KPI + filtri + drawer + timeline
- Nuova prenotazione
- Le mie prenotazioni (agency)

## Step 5 - Mappa
- Leaflet OSM
- Marker hotel + layer servizi
- Filtri + sidebar

## Step 6 - Driver
- Mobile-first
- Servizi assegnati oggi
- Dettaglio + cambio stato + navigazione

## Step 7 - Email Ingestion WOW + Demo
- `POST /api/email/inbound` con token
- Inbox UI + parser + conversione servizio
- README demo + DEMO_SCRIPT + deploy Vercel
