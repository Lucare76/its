-- FIX P2 (audit pre-go-live) — Storage RLS vehicle-documents: le policy
-- live su storage.objects (create in migration 0160) autorizzano
-- SELECT/INSERT/DELETE a chiunque abbia "auth.uid() is not null", senza
-- alcun controllo di tenant o ruolo. Nessuna policy UPDATE esiste.
--
-- Verificato live (query pg_policies fornite dall'utente):
--   vehicle-documents SELECT/INSERT/DELETE -> qualunque auth.uid() non null
--   vehicle-documents UPDATE -> nessuna policy
-- Bucket config live (file_size_limit=10485760, MIME pdf/jpeg/png/webp)
-- e' invece corretta e resta invariata: quella parte NON e' oggetto di
-- questa migration.
--
-- CONFIRMED GAP: un utente autenticato di QUALUNQUE tenant e QUALUNQUE
-- ruolo (incluso driver/agency) puo' leggere, caricare o cancellare
-- documenti del veicolo di un ALTRO tenant chiamando direttamente l'API
-- Storage di Supabase (supabase.storage.from("vehicle-documents")...),
-- bypassando l'applicazione e i suoi controlli (route
-- /api/ops/vehicle-documents e /api/vehicles/[id]/libretto, che
-- verificano tenant/ruolo solo sui metadati in public.vehicle_documents /
-- public.vehicles, mai sui bytes in Storage).
--
-- Il path oggetto e' "${vehicleId}/..." (mai "${tenantId}/..."): il
-- tenant va quindi derivato con un JOIN su public.vehicles (id ->
-- tenant_id), non dal primo segmento del path come tenant_id diretto.
--
-- Ruoli ammessi: admin/operator/supervisor, stesso set gia' richiesto da
-- authorizePricingRequest nelle due route server che gestiscono questo
-- bucket. driver e agency vengono negati (nessun caso d'uso noto nel
-- prodotto attuale per l'upload/lettura/cancellazione diretta di
-- documenti veicolo).
--
-- UPDATE: aggiunta per la prima volta. Necessaria per upsert:true, usato
-- da handleLibrettoUpload (fleet-ops/vehicle/[id]/page.tsx) — quando
-- l'oggetto con lo stesso path esiste gia', l'upload effettua un vero
-- UPDATE lato storage-api, non un nuovo INSERT, e senza policy UPDATE
-- Supabase Storage lo rifiuterebbe silenziosamente in caso di overwrite
-- reale. Nella pratica attuale il path include sempre un timestamp
-- (Date.now()), quindi non si verifica mai un vero conflitto — ma la
-- UPDATE viene comunque aggiunta, simmetrica alle altre 3, per non
-- lasciare l'overwrite esplicito dipendente da un comportamento
-- implicito/accidentale.
--
-- Il predicato "path -> vehicle -> tenant" e' centralizzato in una
-- funzione dedicata (stesso pattern di public.is_driver_assigned_service,
-- migration 0007) per evitare di duplicare 4 volte lo stesso EXISTS/CASE
-- nelle 4 policy. Il CASE prima del cast a uuid evita che un path con un
-- primo segmento non-UUID (input malformato/malevolo) faccia sollevare
-- un errore di cast invece di semplicemente negare l'accesso.
--
-- NON modifica: bucket config, altri bucket (vehicle-damage-photos,
-- bus-qr-codes, backups), public.vehicle_documents (tabella, RLS gia'
-- corretta in 0191), service_role (bypassa sempre RLS).

create or replace function public.vehicle_document_object_authorized(object_name text)
returns boolean
language sql
stable
as $$
  select
    exists (
      select 1
      from public.vehicles v
      where v.id = (
        case
          when (storage.foldername(object_name))[1]
            ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          then ((storage.foldername(object_name))[1])::uuid
          else null
        end
      )
      and v.tenant_id = public.current_tenant_id()
    )
    and public.current_user_role() in ('admin', 'operator', 'supervisor')
$$;

drop policy if exists vehicle_documents_select on storage.objects;
drop policy if exists vehicle_documents_insert on storage.objects;
drop policy if exists vehicle_documents_update on storage.objects;
drop policy if exists vehicle_documents_delete on storage.objects;

create policy vehicle_documents_select
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'vehicle-documents'
    and public.vehicle_document_object_authorized(name)
  );

create policy vehicle_documents_insert
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'vehicle-documents'
    and public.vehicle_document_object_authorized(name)
  );

create policy vehicle_documents_update
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'vehicle-documents'
    and public.vehicle_document_object_authorized(name)
  )
  with check (
    bucket_id = 'vehicle-documents'
    and public.vehicle_document_object_authorized(name)
  );

create policy vehicle_documents_delete
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'vehicle-documents'
    and public.vehicle_document_object_authorized(name)
  );
