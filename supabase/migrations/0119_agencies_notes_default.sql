-- Rende la colonna notes della tabella agencies nullable con default stringa vuota.
-- Risolve l'errore "null value in column notes violates not-null constraint"
-- quando si crea una nuova agenzia senza specificare le note.

ALTER TABLE public.agencies
  ALTER COLUMN notes SET DEFAULT '',
  ALTER COLUMN notes DROP NOT NULL;
