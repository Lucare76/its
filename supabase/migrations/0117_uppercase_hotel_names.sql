-- Normalizza tutti i nomi hotel in MAIUSCOLO
-- Rimuove anche spazi extra (trim) per pulizia
UPDATE public.hotels
SET name = UPPER(TRIM(name))
WHERE name IS NOT NULL
  AND name != UPPER(TRIM(name));
