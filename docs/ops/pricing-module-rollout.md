# Rollout Modulo Tariffe e Margini

## 1) Migrazioni Supabase
Eseguire in SQL Editor (production) in ordine:
1. `supabase/migrations/0012_tariffs_and_margins.sql`
2. `supabase/migrations/0013_pricing_audit_triggers.sql`
3. `supabase/migrations/0014_pricing_advanced_rules.sql`

## 2) Verifiche SQL minime
```sql
select column_name from information_schema.columns where table_schema='public' and table_name='price_lists' and column_name='agency_id';
select column_name from information_schema.columns where table_schema='public' and table_name='pricing_rules' and column_name in ('vehicle_type','time_from','time_to','season_from','season_to','needs_manual_review');
select column_name from information_schema.columns where table_schema='public' and table_name='inbound_booking_imports' and column_name in ('match_quality','review_required','reviewed_at');
select column_name from information_schema.columns where table_schema='public' and table_name='service_pricing' and column_name in ('manual_override','manual_override_reason');
select column_name from information_schema.columns where table_schema='public' and table_name='services' and column_name in ('pricing_manual_override','pricing_manual_override_reason');
```

## 3) Build e test locali
```bash
pnpm lint
pnpm build
pnpm e2e -- --workers=1 --reporter=line tests/e2e/pricing.spec.ts
```

## 4) Deploy Vercel
```bash
git add .
git commit -m "feat(pricing): advanced matching, override, bulk actions, history filters"
git push origin main
```

## 5) Smoke test post-deploy
1. Aprire `/pricing` e verificare le 5 sottosezioni.
2. In `Regole prezzo` creare regola con fascia oraria/veicolo.
3. In `Match prenotazioni` eseguire `Rielabora` su una riga.
4. In `Storico margini` applicare filtro per agenzia e tratta.
5. In `Inbox` aprire draft collegato e usare `Applica override` pricing.
