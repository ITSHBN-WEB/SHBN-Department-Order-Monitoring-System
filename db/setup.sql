-- DOMS database setup for Neon (Postgres).
-- Safe to re-run: tables are created only if missing, and re-running refreshes
-- category limits from the list below without touching existing entries.

create table if not exists categories (
  id          serial primary key,
  department  text not null,
  name        text not null,
  limit_value numeric(14,2) not null check (limit_value >= 0),
  sort_order  int  not null default 0,
  unique (department, name)
);

create table if not exists settings (
  key   text primary key,
  value text not null
);

create table if not exists entries (
  id           bigserial primary key,
  category_id  int  not null references categories(id),
  value        numeric(14,2) not null check (value > 0),
  submitted_by text not null,
  entry_date   date not null,          -- calendar date in Asia/Kuala_Lumpur
  cycle_no     int  not null,          -- 0 = Test Cycle, 1+ = live 45-day cycles
  created_at   timestamptz not null default now()
);

-- Safeguard for simultaneous / repeated submits: each submission carries a unique request id,
-- so a double-click or network retry can only ever be saved once.
alter table entries add column if not exists request_id uuid;
alter table entries add column if not exists edited_at timestamptz;   -- set when an admin edits an entry
create unique index if not exists entries_request_id_uq on entries (request_id);

create index if not exists entries_cycle_cat_idx on entries (cycle_no, category_id);
create index if not exists entries_created_idx   on entries (created_at desc);

-- Tracking settings (only inserted if missing, so re-running never resets them)
insert into settings (key, value) values
  ('tracking_start', '2026-11-01'),   -- live cycle 1 starts here
  ('cycle_days',     '45'),
  ('test_start',     '2026-10-01'),   -- Test Cycle (practice data, stored as cycle 0)
  ('test_end',       '2026-10-30'),
  ('dates_v2',       '1')             -- marks that these dates are the current ones (see lib/db.js)
on conflict (key) do nothing;

update entries set submitted_by = upper(submitted_by) where submitted_by <> upper(submitted_by);

-- Department / category / limit value (from Department_Value.xlsx)
insert into categories (department, name, limit_value, sort_order) values
  ('FOOD', 'BEVERAGES', 283802.00, 1),
  ('FOOD', 'CONFECTIONERY', 266760.00, 2),
  ('FOOD', 'RICE', 178126.00, 3),
  ('FOOD', 'CONDIMENTS / SEASONINGS', 162570.00, 4),
  ('FOOD', 'MILK POWDER', 113329.00, 5),
  ('FOOD', 'NOODLES / PORRIDGE / PASTA', 103662.00, 6),
  ('FOOD', 'CANNED & BOTTLED FOODS', 61846.00, 7),
  ('FOOD', 'COOKING OIL', 55002.00, 8),
  ('FOOD', 'BAKING NEEDS', 38227.00, 9),
  ('FOOD', 'BAKERY', 45225.00, 10),
  ('FOOD', 'BREAKFAST FOODS & SPREAD', 27494.00, 11),
  ('FOOD', 'ORGANIC', 1694.00, 12),
  ('FRESH', 'FROZEN / CHILL / DAIRY', 219911.00, 13),
  ('FRESH', 'MEAT & POULTRY', 135256.00, 14),
  ('FRESH', 'VEGETABLES', 73020.00, 15),
  ('FRESH', 'FRUITS', 70359.00, 16),
  ('FRESH', 'DRIED FOOD', 16346.00, 17),
  ('FRESH', 'PREPACKED FOOD', 10162.00, 18),
  ('FRESH', 'ALCOHOLIC DRINKS', 13991.00, 19),
  ('NONFOOD', 'BABY CARE', 74329.00, 20),
  ('NONFOOD', 'BODY CARE', 59870.00, 21),
  ('NONFOOD', 'DENTAL CARE', 37579.00, 22),
  ('NONFOOD', 'HAIR CARE', 31364.00, 23),
  ('NONFOOD', 'SANITARY & DIAPERS', 30715.00, 24),
  ('NONFOOD', 'PAPER PRODUCT', 28113.00, 25),
  ('NONFOOD', 'FACIAL CARE & COSMETICS', 15576.00, 26),
  ('NONFOOD', 'AIR FRESHENERS', 22839.00, 27),
  ('NONFOOD', 'HEALTH FOOD / MEDICINE / FIRST AID', 12808.00, 28),
  ('NONFOOD', 'PET FOOD', 20745.00, 29),
  ('NONFOOD', 'TOBACCO / MAGAZINE & NEWSPAPER', 3902.00, 30),
  ('NONFOOD', 'BATTERY / LIGHT SOURCE', 2793.00, 31)
on conflict (department, name) do update
  set limit_value = excluded.limit_value,
      sort_order  = excluded.sort_order;
