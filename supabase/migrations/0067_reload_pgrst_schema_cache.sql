-- Forza PostgREST a ricaricare la schema cache per esporre meeting_point
-- (colonna già presente nel DB ma non nella cache REST)
alter table public.services alter column meeting_point type text;

-- Notifica esplicita per il reload
notify pgrst, 'reload schema';
