# Supabase Checklist (Domani Mattina)

## 1) Verifiche account e tenant
- Confermare utente admin reale: `rennasday@gmail.com`.
- Verificare membership valida in `public.memberships`:
  - `user_id` corretto
  - `tenant_id` valorizzato
  - `role` in minuscolo (`admin`)
- Verificare tenant esistente in `public.tenants` con nome azienda demo.

## 2) Query SQL di controllo
```sql
select id, email
from auth.users
where lower(email) = lower('rennasday@gmail.com');

select m.user_id, m.tenant_id, m.role, t.name as tenant_name
from public.memberships m
left join public.tenants t on t.id = m.tenant_id
where m.user_id = '<USER_ID>';
```

## 3) Fix rapido membership (solo se necessario)
```sql
update public.memberships
set role = lower(role)
where role <> lower(role);
```

## 4) Env produzione da verificare in Vercel
- Obbligatorie:
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `EMAIL_INBOUND_TOKEN`
  - `CRON_SECRET`
- Beta email/PDF:
  - `IMAP_HOST=imap.gmail.com`
  - `IMAP_PORT=993`
  - `IMAP_USER=rennasday@gmail.com`
  - `IMAP_PASS=<GMAIL_APP_PASSWORD>`
  - `IMAP_TLS=true`
- Conferme agenzia:
  - `RESEND_API_KEY` (se attivo invio reale)
  - `AGENCY_BOOKING_FROM_EMAIL`
  - `AGENCY_BOOKING_BETA_RECIPIENT_EMAIL=rennasday@gmail.com`

## 5) Test smoke manuale
- Login admin.
- `/onboarding`: Step 1 crea tenant (se mancante) -> redirect dashboard.
- `/dashboard`: KPI visibili, niente loop onboarding/login.
- `/inbox`: upload PDF manuale -> record inbox + draft service creato.
- `/services/new`: creazione prenotazione riuscita.

## 6) Se qualcosa fallisce
- Aprire `/health` e controllare variabili mancanti.
- Controllare log Vercel su status `500`:
```bash
vercel logs --environment production --status-code 500 --since 1h --no-follow --limit 100 --expand
```
