-- Ischia Transfer Beta
-- Fix login "Pagina disponibile solo con login Supabase reale"
-- Uso: incolla i blocchi in Supabase SQL Editor, in ordine.

-- =========================================================
-- BLOCCO 1: Diagnostica utenti + membership
-- =========================================================
select
  u.id as user_id,
  u.email,
  m.tenant_id,
  m.role,
  m.full_name,
  u.created_at as user_created_at
from auth.users u
left join public.memberships m on m.user_id = u.id
order by u.created_at desc;


-- =========================================================
-- BLOCCO 2: Elenco tenant disponibili
-- =========================================================
select id, name, created_at
from public.tenants
order by created_at asc;


-- =========================================================
-- BLOCCO 3: UPSERT membership per un utente specifico
-- =========================================================
-- SOSTITUISCI:
--   - METTI_QUI_TENANT_ID
--   - TUA_EMAIL@DOMINIO.COM
--   - Nome Operatore
--   - ruolo: admin | operator | agency | driver
insert into public.memberships (user_id, tenant_id, role, full_name)
select
  u.id,
  '11111111-1111-1111-1111-111111111111'::uuid,
  'operator'::public.app_role,
  'Nome Operatore'
from auth.users u
where lower(u.email) = lower('rennasday@gmail.com')
on conflict (user_id, tenant_id)
do update set
  role = excluded.role,
  full_name = excluded.full_name;


-- =========================================================
-- BLOCCO 4: Verifica finale membership utente
-- =========================================================
-- SOSTITUISCI TUA_EMAIL@DOMINIO.COM
select
  u.id as user_id,
  u.email,
  m.tenant_id,
  m.role,
  m.full_name
from auth.users u
join public.memberships m on m.user_id = u.id
where lower(u.email) = lower('rennasday@gmail.com');


-- =========================================================
-- BLOCCO 5 (OPZIONALE): allinea ruolo anche per stesso utente su tutti i tenant
-- =========================================================
-- SOSTITUISCI:
--   - TUA_EMAIL@DOMINIO.COM
--   - Nuovo Nome
--   - ruolo desiderato
update public.memberships m
set
  role = 'admin'::public.app_role,
  full_name = 'Luca Renna'
from auth.users u
where m.user_id = u.id
  and lower(u.email) = lower('renna);

