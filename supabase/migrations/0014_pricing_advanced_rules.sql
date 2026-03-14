-- Migration: Pricing advanced rules (veicolo/fascia/stagione/listino agenzia/match quality/manual override)

-- 1) Enum qualità match
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'pricing_match_quality') THEN
    CREATE TYPE public.pricing_match_quality AS ENUM ('certain', 'partial', 'review');
  END IF;
END $$;

-- 2) Listini: supporto listino riservato agenzia
ALTER TABLE public.price_lists
  ADD COLUMN IF NOT EXISTS agency_id uuid NULL REFERENCES public.agencies (id) ON DELETE SET NULL;

-- sostituisce il vincolo precedente con varianti public + per agenzia
DROP INDEX IF EXISTS public.uq_price_lists_default_per_tenant;
CREATE UNIQUE INDEX IF NOT EXISTS uq_price_lists_default_public_per_tenant
  ON public.price_lists (tenant_id)
  WHERE (is_default AND active AND agency_id IS NULL);

CREATE UNIQUE INDEX IF NOT EXISTS uq_price_lists_default_agency_per_tenant
  ON public.price_lists (tenant_id, agency_id)
  WHERE (is_default AND active AND agency_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_price_lists_tenant_agency_dates
  ON public.price_lists (tenant_id, agency_id, active, valid_from, valid_to);

-- 3) Regole pricing avanzate
ALTER TABLE public.pricing_rules
  ADD COLUMN IF NOT EXISTS vehicle_type text NULL,
  ADD COLUMN IF NOT EXISTS time_from time NULL,
  ADD COLUMN IF NOT EXISTS time_to time NULL,
  ADD COLUMN IF NOT EXISTS season_from date NULL,
  ADD COLUMN IF NOT EXISTS season_to date NULL,
  ADD COLUMN IF NOT EXISTS needs_manual_review boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pricing_rules_vehicle_type_not_blank'
      AND conrelid = 'public.pricing_rules'::regclass
  ) THEN
    ALTER TABLE public.pricing_rules
      ADD CONSTRAINT pricing_rules_vehicle_type_not_blank
      CHECK (vehicle_type IS NULL OR length(trim(vehicle_type)) > 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pricing_rules_time_window_valid'
      AND conrelid = 'public.pricing_rules'::regclass
  ) THEN
    ALTER TABLE public.pricing_rules
      ADD CONSTRAINT pricing_rules_time_window_valid
      CHECK (
        time_from IS NULL
        OR time_to IS NULL
        OR time_to >= time_from
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pricing_rules_season_window_valid'
      AND conrelid = 'public.pricing_rules'::regclass
  ) THEN
    ALTER TABLE public.pricing_rules
      ADD CONSTRAINT pricing_rules_season_window_valid
      CHECK (
        season_from IS NULL
        OR season_to IS NULL
        OR season_to >= season_from
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_pricing_rules_vehicle_time_season
  ON public.pricing_rules (tenant_id, active, vehicle_type, time_from, time_to, season_from, season_to, priority);

-- 4) Import prenotazioni: qualità match e revisione operatore
ALTER TABLE public.inbound_booking_imports
  ADD COLUMN IF NOT EXISTS match_quality public.pricing_match_quality NULL,
  ADD COLUMN IF NOT EXISTS review_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reviewed_by_user_id uuid NULL REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS idx_inbound_booking_imports_quality
  ON public.inbound_booking_imports (tenant_id, match_quality, review_required, created_at DESC);

-- 5) Storico pricing servizio: override manuale
ALTER TABLE public.service_pricing
  ADD COLUMN IF NOT EXISTS manual_override boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS manual_override_reason text NOT NULL DEFAULT '';

-- 6) Servizi: flag override per integrazione operativa
ALTER TABLE public.services
  ADD COLUMN IF NOT EXISTS pricing_manual_override boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pricing_manual_override_reason text NOT NULL DEFAULT '';
