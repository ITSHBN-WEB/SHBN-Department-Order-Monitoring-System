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

-- Sign-in accounts. password_hash is a salted scrypt hash, never the password itself.
create table if not exists accounts (
  code          text primary key,       -- e.g. 1008-SHBN
  password_hash text not null
);
insert into accounts (code, password_hash) values
  ('1008-SHBN', 'scrypt$ia2gX+KUSB3nW1jC8aef+w==$PKGBjpoL3ejiiArnmeyw9QEWyRPpZpHe6dOlV2ORhFU='),
  ('1015-SHPL', 'scrypt$vXeP8idFovCslQTG6+nFig==$XSjpgYxxyfSYxkKSmLBKYqfugwmFRuNbBvGNvk/a5vY='),
  ('1007-SHPP', 'scrypt$m7zUpXYQbgzUqS7/tVwqUQ==$VsCbLcRb3fpqqzQXRNRv8kJtZOEIlpgQlqrx8xdStH8=')
on conflict (code) do nothing;

create table if not exists entries (
  id           bigserial primary key,
  account      text not null references accounts(code),   -- which account (store) made the entry
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

-- Upgrading an older database: add the account column and give existing entries to 1008-SHBN
alter table entries add column if not exists account text;
update entries set account = '1008-SHBN' where account is null;
alter table entries alter column account set not null;
create index if not exists entries_account_idx on entries (account, cycle_no, category_id);

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

-- Admin tab passwords (hashes): per-account admin, and head-office admin for all accounts
insert into settings (key, value) values
  ('admin_hash', 'scrypt$qP7RAkDQl1NnTCqtf8vfSg==$nZNWs6aZhMi8nvE1TpfMrP+iOgr3fngnDTaK+kDUZYo='),
  ('hq_hash',    'scrypt$00Ft+txDUte+/JMCX8EF7g==$pnMXq/AF6ZmfvMwS1DN1Rb4xRdmfGKYZDCjRYTj1xmA=')
on conflict (key) do nothing;

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

-- Limits per account (from Department_Value.xlsx: sheet SHBN -> 1008-SHBN, SHPL -> 1015-SHPL, SHPP -> 1007-SHPP).
-- Re-running this file refreshes the limits from the list below.
create table if not exists account_limits (
  account     text not null references accounts(code),
  category_id int  not null references categories(id),
  limit_value numeric(14,2) not null check (limit_value >= 0),
  primary key (account, category_id)
);

insert into account_limits (account, category_id, limit_value)
select v.account, c.id, v.limit_value
from (values
  ('1008-SHBN', 'FOOD', 'BEVERAGES', 283802),
  ('1008-SHBN', 'FOOD', 'CONFECTIONERY', 266760),
  ('1008-SHBN', 'FOOD', 'RICE', 178126),
  ('1008-SHBN', 'FOOD', 'CONDIMENTS / SEASONINGS', 162570),
  ('1008-SHBN', 'FOOD', 'MILK POWDER', 113329),
  ('1008-SHBN', 'FOOD', 'NOODLES / PORRIDGE / PASTA', 103662),
  ('1008-SHBN', 'FOOD', 'CANNED & BOTTLED FOODS', 61846),
  ('1008-SHBN', 'FOOD', 'COOKING OIL', 55002),
  ('1008-SHBN', 'FOOD', 'BAKING NEEDS', 38227),
  ('1008-SHBN', 'FOOD', 'BAKERY', 45225),
  ('1008-SHBN', 'FOOD', 'BREAKFAST FOODS & SPREAD', 27494),
  ('1008-SHBN', 'FOOD', 'ORGANIC', 1694),
  ('1008-SHBN', 'FRESH', 'FROZEN / CHILL / DAIRY', 219911),
  ('1008-SHBN', 'FRESH', 'MEAT & POULTRY', 135256),
  ('1008-SHBN', 'FRESH', 'VEGETABLES', 73020),
  ('1008-SHBN', 'FRESH', 'FRUITS', 70359),
  ('1008-SHBN', 'FRESH', 'DRIED FOOD', 16346),
  ('1008-SHBN', 'FRESH', 'PREPACKED FOOD', 10162),
  ('1008-SHBN', 'FRESH', 'ALCOHOLIC DRINKS', 13991),
  ('1008-SHBN', 'NONFOOD', 'BABY CARE', 74329),
  ('1008-SHBN', 'NONFOOD', 'BODY CARE', 59870),
  ('1008-SHBN', 'NONFOOD', 'DENTAL CARE', 37579),
  ('1008-SHBN', 'NONFOOD', 'HAIR CARE', 31364),
  ('1008-SHBN', 'NONFOOD', 'SANITARY & DIAPERS', 30715),
  ('1008-SHBN', 'NONFOOD', 'PAPER PRODUCT', 28113),
  ('1008-SHBN', 'NONFOOD', 'FACIAL CARE & COSMETICS', 15576),
  ('1008-SHBN', 'NONFOOD', 'AIR FRESHENERS', 22839),
  ('1008-SHBN', 'NONFOOD', 'HEALTH FOOD / MEDICINE / FIRST AID', 12808),
  ('1008-SHBN', 'NONFOOD', 'PET FOOD', 20745),
  ('1008-SHBN', 'NONFOOD', 'TOBACCO / MAGAZINE & NEWSPAPER', 3902),
  ('1008-SHBN', 'NONFOOD', 'BATTERY / LIGHT SOURCE', 2793),
  ('1015-SHPL', 'FOOD', 'BEVERAGES', 165559),
  ('1015-SHPL', 'FOOD', 'CONFECTIONERY', 180246),
  ('1015-SHPL', 'FOOD', 'RICE', 66875),
  ('1015-SHPL', 'FOOD', 'CONDIMENTS / SEASONINGS', 97471),
  ('1015-SHPL', 'FOOD', 'MILK POWDER', 62794),
  ('1015-SHPL', 'FOOD', 'NOODLES / PORRIDGE / PASTA', 59431),
  ('1015-SHPL', 'FOOD', 'CANNED & BOTTLED FOODS', 37172),
  ('1015-SHPL', 'FOOD', 'COOKING OIL', 34606),
  ('1015-SHPL', 'FOOD', 'BAKING NEEDS', 21043),
  ('1015-SHPL', 'FOOD', 'BAKERY', 29314),
  ('1015-SHPL', 'FOOD', 'BREAKFAST FOODS & SPREAD', 18611),
  ('1015-SHPL', 'FOOD', 'ORGANIC', 2312),
  ('1015-SHPL', 'FRESH', 'FROZEN / CHILL / DAIRY', 174981),
  ('1015-SHPL', 'FRESH', 'MEAT & POULTRY', 78808),
  ('1015-SHPL', 'FRESH', 'VEGETABLES', 50905),
  ('1015-SHPL', 'FRESH', 'FRUITS', 40169),
  ('1015-SHPL', 'FRESH', 'DRIED FOOD', 8293),
  ('1015-SHPL', 'FRESH', 'PREPACKED FOOD', 7216),
  ('1015-SHPL', 'FRESH', 'ALCOHOLIC DRINKS', 6122),
  ('1015-SHPL', 'NONFOOD', 'BABY CARE', 41879),
  ('1015-SHPL', 'NONFOOD', 'BODY CARE', 43893),
  ('1015-SHPL', 'NONFOOD', 'DENTAL CARE', 26077),
  ('1015-SHPL', 'NONFOOD', 'HAIR CARE', 22282),
  ('1015-SHPL', 'NONFOOD', 'SANITARY & DIAPERS', 21635),
  ('1015-SHPL', 'NONFOOD', 'PAPER PRODUCT', 21677),
  ('1015-SHPL', 'NONFOOD', 'FACIAL CARE & COSMETICS', 13810),
  ('1015-SHPL', 'NONFOOD', 'AIR FRESHENERS', 15243),
  ('1015-SHPL', 'NONFOOD', 'HEALTH FOOD / MEDICINE / FIRST AID', 8684),
  ('1015-SHPL', 'NONFOOD', 'PET FOOD', 16016),
  ('1015-SHPL', 'NONFOOD', 'TOBACCO / MAGAZINE & NEWSPAPER', 1365),
  ('1015-SHPL', 'NONFOOD', 'BATTERY / LIGHT SOURCE', 1754),
  ('1007-SHPP', 'FOOD', 'BEVERAGES', 160157),
  ('1007-SHPP', 'FOOD', 'CONFECTIONERY', 181681),
  ('1007-SHPP', 'FOOD', 'RICE', 102088),
  ('1007-SHPP', 'FOOD', 'CONDIMENTS / SEASONINGS', 88182),
  ('1007-SHPP', 'FOOD', 'MILK POWDER', 75755),
  ('1007-SHPP', 'FOOD', 'NOODLES / PORRIDGE / PASTA', 61434),
  ('1007-SHPP', 'FOOD', 'CANNED & BOTTLED FOODS', 36175),
  ('1007-SHPP', 'FOOD', 'COOKING OIL', 36006),
  ('1007-SHPP', 'FOOD', 'BAKING NEEDS', 20448),
  ('1007-SHPP', 'FOOD', 'BAKERY', 33527),
  ('1007-SHPP', 'FOOD', 'BREAKFAST FOODS & SPREAD', 17247),
  ('1007-SHPP', 'FOOD', 'ORGANIC', 791),
  ('1007-SHPP', 'FRESH', 'FROZEN / CHILL / DAIRY', 142123),
  ('1007-SHPP', 'FRESH', 'MEAT & POULTRY', 91977),
  ('1007-SHPP', 'FRESH', 'VEGETABLES', 39428),
  ('1007-SHPP', 'FRESH', 'FRUITS', 33794),
  ('1007-SHPP', 'FRESH', 'DRIED FOOD', 9747),
  ('1007-SHPP', 'FRESH', 'PREPACKED FOOD', 3380),
  ('1007-SHPP', 'FRESH', 'ALCOHOLIC DRINKS', 7096),
  ('1007-SHPP', 'NONFOOD', 'BABY CARE', 47734),
  ('1007-SHPP', 'NONFOOD', 'BODY CARE', 42823),
  ('1007-SHPP', 'NONFOOD', 'DENTAL CARE', 27207),
  ('1007-SHPP', 'NONFOOD', 'HAIR CARE', 19746),
  ('1007-SHPP', 'NONFOOD', 'SANITARY & DIAPERS', 18102),
  ('1007-SHPP', 'NONFOOD', 'PAPER PRODUCT', 19177),
  ('1007-SHPP', 'NONFOOD', 'FACIAL CARE & COSMETICS', 10656),
  ('1007-SHPP', 'NONFOOD', 'AIR FRESHENERS', 14419),
  ('1007-SHPP', 'NONFOOD', 'HEALTH FOOD / MEDICINE / FIRST AID', 4632),
  ('1007-SHPP', 'NONFOOD', 'PET FOOD', 11683),
  ('1007-SHPP', 'NONFOOD', 'TOBACCO / MAGAZINE & NEWSPAPER', 1712),
  ('1007-SHPP', 'NONFOOD', 'BATTERY / LIGHT SOURCE', 2239)
) as v(account, department, name, limit_value)
join categories c on c.department = v.department and c.name = v.name
on conflict (account, category_id) do update set limit_value = excluded.limit_value;

insert into settings (key, value) values ('limits_v2', '1') on conflict (key) do nothing;   -- see lib/db.js
