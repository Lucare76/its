# Area Agenzia - Consolidamento Production Ready

## 1) Coerenza modulo
- API create/list: `POST /api/agency/bookings` e `GET /api/agency/bookings` attive.
- Persistenza primaria su `public.services`.
- Evento iniziale su `public.status_events` (`status = new`) alla creazione.
- Validazione hotel su tenant corrente.
- Visibilita:
- `agency`: solo record `created_by_user_id = auth.uid()`.
- `admin`: tutti i record del tenant.
- Compatibilita dispatch/pricing:
- campi core `date/time/service_type/direction/pax/hotel_id/status` sempre valorizzati.
- nessuna dipendenza da logica demo.

## 2) Stato migration 0019
Migration: `supabase/migrations/0019_agency_booking_module.sql`.

Copertura campi modulo:
- customer: `customer_first_name`, `customer_last_name`, `customer_email`.
- servizio: `booking_service_kind`, `transport_code`, `bus_city_origin`.
- date/ore: `arrival_date`, `arrival_time`, `departure_date`, `departure_time`.
- ferry/excursion: `include_ferry_tickets`, `ferry_details`, `excursion_details`.
- conferma email: `email_confirmation_to`, `email_confirmation_status`, `email_confirmation_error`, `email_confirmation_sent_at`.

Vincoli:
- check su `booking_service_kind`.
- check su `email_confirmation_status`.
- indici dedicati per query operative.

## 2b) Allineamento runtime 0020
Migration: `supabase/migrations/0020_agency_booking_runtime_alignment.sql`.

Campi/runtime aggiuntivi richiesti dall'API:
- `services.created_by_user_id` per ownership forte lato `agency`.
- indice `idx_services_tenant_created_by_date` per query elenco/duplicati.
- `agencies.external_code` per auto-associare l'utente agency alla propria agenzia.
- unique index `uq_agencies_tenant_external_code` per evitare duplicati logici.

Conclusione operativa:
- il modulo non e production-ready con la sola `0019`.
- in ambiente reale vanno applicate `0019` e `0020` entrambe.

## 3) Checklist applicazione migration su Supabase reale
1. Apri Supabase SQL Editor (progetto produzione/beta).
2. Esegui `0019_agency_booking_module.sql`.
3. Esegui `0020_agency_booking_runtime_alignment.sql`.
4. Verifica colonne booking:
```sql
select column_name
from information_schema.columns
where table_schema = 'public' and table_name = 'services'
  and column_name in (
    'booking_service_kind','customer_first_name','customer_last_name','customer_email',
    'arrival_date','arrival_time','departure_date','departure_time',
    'transport_code','bus_city_origin','include_ferry_tickets',
    'ferry_details','excursion_details',
    'email_confirmation_to','email_confirmation_status',
    'email_confirmation_error','email_confirmation_sent_at'
  )
order by column_name;
```
5. Verifica colonne runtime aggiuntive:
```sql
select table_name, column_name
from information_schema.columns
where table_schema = 'public'
  and (
    (table_name = 'services' and column_name in ('created_by_user_id'))
    or (table_name = 'agencies' and column_name in ('external_code'))
  )
order by table_name, column_name;
```
6. Verifica vincoli:
```sql
select conname
from pg_constraint
where conname in (
  'services_booking_service_kind_valid',
  'services_email_confirmation_status_valid'
);
```
7. Verifica indici:
```sql
select indexname
from pg_indexes
where schemaname='public' and tablename='services'
  and indexname in (
    'idx_services_booking_kind_date',
    'idx_services_email_confirmation_status',
    'idx_services_tenant_created_by_date'
  );
```
8. Verifica indice univoco agencies:
```sql
select indexname
from pg_indexes
where schemaname='public' and tablename='agencies'
  and indexname in ('uq_agencies_tenant_external_code');
```

## 3b) Checklist RLS area agency
Obiettivo: garantire che `agency` veda solo i propri booking e che `admin/operator` mantengano la vista tenant-wide operativa.

Nota architetturale:
- le route server `app/api/agency/bookings` usano `SUPABASE_SERVICE_ROLE_KEY`.
- questo significa che in quel flusso la segregazione reale dipende da due livelli: autorizzazione applicativa (`membership.role`) e filtri query (`tenant_id`, `created_by_user_id`, `agency_id`).
- le policy RLS restano comunque obbligatorie per client-side Supabase, query dirette e difesa in profondita.

1. Verifica policy `services`:
```sql
select policyname, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename = 'services'
  and policyname in (
    'services_select_admin_operator_tenant',
    'services_select_agency_owned',
    'services_insert_admin_operator',
    'services_insert_agency_owned',
    'services_update_admin_operator',
    'services_update_agency_owned'
  )
order by policyname;
```
2. Verifica policy `status_events`:
```sql
select policyname, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename = 'status_events'
  and policyname in (
    'status_events_select_admin_operator_tenant',
    'status_events_select_agency_owned_service',
    'status_events_insert_admin_operator',
    'status_events_insert_agency_owned_service'
  )
order by policyname;
```
3. Verifica policy `agencies`:
```sql
select policyname, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename = 'agencies'
  and policyname in (
    'agencies_select_tenant_member',
    'agencies_insert_admin_operator',
    'agencies_update_admin_operator'
  )
order by policyname;
```

## 4) Test manuale end-to-end
1. Login come utente `agency`.
2. Apri `/agency/new-booking`.
3. Crea prenotazione con campi obbligatori.
4. Verifica su DB:
- nuova riga in `services`.
- nuova riga in `status_events` con stesso `service_id` e `status='new'`.
5. Apri `/agency/bookings`: deve vedere solo i propri record.
6. Login come `admin`/`operator`:
- `admin` vede tenant completo in `/agency/bookings`.
- `operator` vede il servizio in pagine operative (`/dispatch`, `/dashboard`) tramite dati `services`.
7. Email conferma:
- con `RESEND_API_KEY` + `AGENCY_BOOKING_FROM_EMAIL` presenti: `email_confirmation_status = sent`.
- senza provider: `email_confirmation_status = skipped`, creazione servizio comunque completata.

## 5) Smoke test reale eseguito il 12 marzo 2026
Verifica eseguita su app locale collegata al progetto Supabase configurato in `.env.local`.

Esito:
- login reale con `agency@demo.com` riuscito.
- `GET /api/agency/bookings` prima della creazione: `before_count = 5`.
- `POST /api/agency/bookings` riuscito con `id = 8e01dbc7-5a42-4de6-8c61-1b74b2044b34`.
- `status_events` iniziale creato con `status = new`.
- `GET /api/agency/bookings` dopo la creazione: `after_count = 6`.
- il nuovo booking risulta visibile all'utente agency (`listed_after = true`).

Nota email:
- provider raggiunto ma invio fallito con `403`.
- motivo corrente: dominio destinatario/mittente non verificato su Resend nel setup attuale.

## 6) Ordine consigliato deploy/verifica
1. Applica `0019_agency_booking_module.sql`.
2. Applica `0020_agency_booking_runtime_alignment.sql`.
3. Verifica colonne, vincoli e indici con le query sopra.
4. Verifica policy RLS `services/status_events/agencies`.
5. Se il login reale mostra "Membership non trovata", usa `docs/ops/fix-login-membership.sql`.
6. Esegui smoke test agency reale.
7. Verifica email conferma solo dopo aver completato la verifica dominio/mittente su Resend.
