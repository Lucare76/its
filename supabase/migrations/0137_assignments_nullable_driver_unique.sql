-- Rende driver_user_id nullable su assignments:
-- il Piano del Giorno può creare giri senza autista assegnato (assegnazione manuale successiva).
ALTER TABLE public.assignments
  ALTER COLUMN driver_user_id DROP NOT NULL;

-- Aggiunge unique constraint su (service_id, tenant_id) per supportare upsert:
-- ogni servizio può avere al massimo un assignment per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS assignments_service_tenant_unique
  ON public.assignments (service_id, tenant_id);
