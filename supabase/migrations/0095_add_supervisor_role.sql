-- Aggiunge il ruolo "supervisor" all'enum app_role
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'supervisor';
