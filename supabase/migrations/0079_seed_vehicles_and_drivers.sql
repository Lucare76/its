-- Seed veicoli Ischia Transfer Service
-- Tenant: d200b89a-64c7-4f8d-a430-95a33b83047a

-- ── Unique index su plate (idempotente, usato da ON CONFLICT) ────────────────
create unique index if not exists vehicles_plate_unique on public.vehicles (plate);

-- ── Veicoli ──────────────────────────────────────────────────────────────────
insert into vehicles (id, tenant_id, label, plate, capacity, vehicle_size, active, notes)
values
  -- BUS (>25 pax)
  (gen_random_uuid(), 'd200b89a-64c7-4f8d-a430-95a33b83047a', 'BEULAS AURA',             'HA696MG', 54, 'bus',    true, 'GPS: sì'),
  (gen_random_uuid(), 'd200b89a-64c7-4f8d-a430-95a33b83047a', '0350 TURISMO',             'EL598VV', 52, 'bus',    true, 'GPS: sì'),
  (gen_random_uuid(), 'd200b89a-64c7-4f8d-a430-95a33b83047a', 'VOLVO GENESIS',            'GK023EV', 52, 'bus',    true, 'GPS: sì'),
  (gen_random_uuid(), 'd200b89a-64c7-4f8d-a430-95a33b83047a', 'DOMINO AUTOMATICO',        'GN676BX', 56, 'bus',    true, 'GPS: sì'),
  (gen_random_uuid(), 'd200b89a-64c7-4f8d-a430-95a33b83047a', 'DOMINO SEMI AUTOMATICO',   'GV235AD', 56, 'bus',    true, 'GPS: sì'),
  (gen_random_uuid(), 'd200b89a-64c7-4f8d-a430-95a33b83047a', 'MERCEDES 0404',            'EZ147JK', 40, 'bus',    true, 'GPS: sì'),
  -- LARGE (25-26 pax)
  (gen_random_uuid(), 'd200b89a-64c7-4f8d-a430-95a33b83047a', '25 BIANCO',                'GH725YC', 25, 'large',  true, 'GPS: sì'),
  (gen_random_uuid(), 'd200b89a-64c7-4f8d-a430-95a33b83047a', '26 IVECO',                 'EX221AK', 26, 'large',  true, 'GPS: sì'),
  (gen_random_uuid(), 'd200b89a-64c7-4f8d-a430-95a33b83047a', '25 NAVARRA',               'GF241BA', 25, 'large',  true, 'GPS: sì'),
  (gen_random_uuid(), 'd200b89a-64c7-4f8d-a430-95a33b83047a', '25 BELUGA',                'GA563FD', 25, 'large',  true, 'GPS: sì'),
  -- MEDIUM (10-16 pax)
  (gen_random_uuid(), 'd200b89a-64c7-4f8d-a430-95a33b83047a', '16 MERCEDES',              'EM302MV', 16, 'medium', true, 'GPS: sì'),
  (gen_random_uuid(), 'd200b89a-64c7-4f8d-a430-95a33b83047a', '16 VOLKSWAGEN',            'EN458SX', 16, 'medium', true, 'GPS: sì'),
  (gen_random_uuid(), 'd200b89a-64c7-4f8d-a430-95a33b83047a', 'DUCATO MAXI',              'CT509GP', 14, 'medium', true, 'GPS: sì'),
  (gen_random_uuid(), 'd200b89a-64c7-4f8d-a430-95a33b83047a', 'RENAULT MASTER',           'EG830GP', 14, 'medium', true, 'GPS: sì'),
  (gen_random_uuid(), 'd200b89a-64c7-4f8d-a430-95a33b83047a', 'TOMMASONE',                'ED657NR', 12, 'medium', true, 'GPS: no'),
  (gen_random_uuid(), 'd200b89a-64c7-4f8d-a430-95a33b83047a', 'TOMMASINI',                'EM332MV', 10, 'medium', true, 'GPS: sì'),
  -- SMALL (≤8 pax)
  (gen_random_uuid(), 'd200b89a-64c7-4f8d-a430-95a33b83047a', 'VITO LONG',                'FE861YD',  8, 'small',  true, 'GPS: sì'),
  (gen_random_uuid(), 'd200b89a-64c7-4f8d-a430-95a33b83047a', 'VITO EXTRA LONG',          'FE604SL',  8, 'small',  true, 'GPS: sì'),
  (gen_random_uuid(), 'd200b89a-64c7-4f8d-a430-95a33b83047a', 'TRASPORTER',               'CC626JZ',  8, 'small',  true, 'GPS: sì'),
  (gen_random_uuid(), 'd200b89a-64c7-4f8d-a430-95a33b83047a', 'DUCATO GRIGIO',            'CC821FS',  8, 'small',  true, 'GPS: sì'),
  (gen_random_uuid(), 'd200b89a-64c7-4f8d-a430-95a33b83047a', 'VITO GRIGIO',              'DL693MM',  8, 'small',  true, 'GPS: sì'),
  (gen_random_uuid(), 'd200b89a-64c7-4f8d-a430-95a33b83047a', 'VITO BIANCO',              'CP908HN',  8, 'small',  true, 'GPS: sì'),
  (gen_random_uuid(), 'd200b89a-64c7-4f8d-a430-95a33b83047a', 'VITO GRIGIO 6 POSTI',      'BK708MR',  6, 'small',  true, 'GPS: no'),
  (gen_random_uuid(), 'd200b89a-64c7-4f8d-a430-95a33b83047a', 'CLASSE E 220',             'DX735KH',  4, 'small',  true, 'GPS: no'),
  (gen_random_uuid(), 'd200b89a-64c7-4f8d-a430-95a33b83047a', 'SAAB 9-5',                 'EK441YC',  4, 'small',  true, 'GPS: no'),
  (gen_random_uuid(), 'd200b89a-64c7-4f8d-a430-95a33b83047a', 'FORD GALAXY',              'CV412YR',  6, 'small',  true, 'GPS: no')
on conflict (plate) do update set
  label        = excluded.label,
  capacity     = excluded.capacity,
  vehicle_size = excluded.vehicle_size,
  notes        = excluded.notes,
  active       = true;
