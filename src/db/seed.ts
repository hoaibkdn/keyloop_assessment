import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { loadConfig } from '../config.js';
import { migrate } from './migrate.js';
import { createPool } from './pool.js';

/** Fixed ids so README / cURL examples and tests are reproducible. */
export const SEED = {
  dealerships: {
    london: '11111111-1111-4111-8111-111111111111',
    manchester: '11111111-1111-4111-8111-222222222222',
  },
  serviceTypes: {
    oilChange: '22222222-2222-4222-8222-000000000001', // 60 min, GENERAL
    brakeService: '22222222-2222-4222-8222-000000000002', // 120 min, BRAKES
    evBatteryCheck: '22222222-2222-4222-8222-000000000003', // 90 min, EV
    annualInspection: '22222222-2222-4222-8222-000000000004', // 45 min, INSPECTION
  },
  technicians: {
    alice: '33333333-3333-4333-8333-000000000001', // GENERAL, BRAKES
    bob: '33333333-3333-4333-8333-000000000002', // GENERAL, EV
    carol: '33333333-3333-4333-8333-000000000003', // EV, INSPECTION, GENERAL
    dan: '33333333-3333-4333-8333-000000000004', // Manchester, GENERAL
  },
  bays: {
    bay1: '44444444-4444-4444-8444-000000000001',
    bay2: '44444444-4444-4444-8444-000000000002',
    bay3: '44444444-4444-4444-8444-000000000003',
    manchesterBay1: '44444444-4444-4444-8444-000000000004',
  },
  customers: {
    jane: '55555555-5555-4555-8555-000000000001',
    raj: '55555555-5555-4555-8555-000000000002',
    mei: '55555555-5555-4555-8555-000000000003',
  },
  vehicles: {
    janeGolf: '66666666-6666-4666-8666-000000000001',
    rajTesla: '66666666-6666-4666-8666-000000000002',
    meiCivic: '66666666-6666-4666-8666-000000000003',
    janeFiesta: '66666666-6666-4666-8666-000000000004',
  },
} as const;

export async function seed(db: pg.Pool | pg.PoolClient): Promise<void> {
  const d = SEED.dealerships;
  const st = SEED.serviceTypes;
  const t = SEED.technicians;
  const b = SEED.bays;
  const c = SEED.customers;
  const v = SEED.vehicles;

  await db.query(
    `INSERT INTO dealerships (id, name, timezone, opens_at, closes_at) VALUES
       ($1, 'Keyloop Motors London', 'Europe/London', '08:00', '18:00'),
       ($2, 'Keyloop Motors Manchester', 'Europe/London', '09:00', '17:00')
     ON CONFLICT (id) DO NOTHING`,
    [d.london, d.manchester],
  );
  await db.query(
    `INSERT INTO service_types (id, code, name, duration_minutes, required_skill) VALUES
       ($1, 'OIL_CHANGE', 'Oil & filter change', 60, 'GENERAL'),
       ($2, 'BRAKE_SERVICE', 'Brake pads & discs', 120, 'BRAKES'),
       ($3, 'EV_BATTERY_CHECK', 'EV battery health check', 90, 'EV'),
       ($4, 'ANNUAL_INSPECTION', 'Annual safety inspection', 45, 'INSPECTION')
     ON CONFLICT (id) DO NOTHING`,
    [st.oilChange, st.brakeService, st.evBatteryCheck, st.annualInspection],
  );
  await db.query(
    `INSERT INTO technicians (id, dealership_id, name, skills) VALUES
       ($1, $5, 'Alice Turner', '{GENERAL,BRAKES}'),
       ($2, $5, 'Bob Singh', '{GENERAL,EV}'),
       ($3, $5, 'Carol Nguyen', '{EV,INSPECTION,GENERAL}'),
       ($4, $6, 'Dan Murphy', '{GENERAL}')
     ON CONFLICT (id) DO NOTHING`,
    [t.alice, t.bob, t.carol, t.dan, d.london, d.manchester],
  );
  await db.query(
    `INSERT INTO service_bays (id, dealership_id, name) VALUES
       ($1, $5, 'Bay 1'), ($2, $5, 'Bay 2'), ($3, $5, 'Bay 3'), ($4, $6, 'Bay 1')
     ON CONFLICT (id) DO NOTHING`,
    [b.bay1, b.bay2, b.bay3, b.manchesterBay1, d.london, d.manchester],
  );
  await db.query(
    `INSERT INTO customers (id, name, email, phone) VALUES
       ($1, 'Jane Doe', 'jane@example.com', '+44 7700 900001'),
       ($2, 'Raj Patel', 'raj@example.com', '+44 7700 900002'),
       ($3, 'Mei Chen', 'mei@example.com', NULL)
     ON CONFLICT (id) DO NOTHING`,
    [c.jane, c.raj, c.mei],
  );
  await db.query(
    `INSERT INTO vehicles (id, customer_id, vin, make, model, year) VALUES
       ($1, $5, 'WVWZZZ1KZAW000001', 'Volkswagen', 'Golf', 2019),
       ($2, $6, '5YJ3E1EA7KF000002', 'Tesla', 'Model 3', 2021),
       ($3, $7, 'SHHFK7H50KU000003', 'Honda', 'Civic', 2020),
       ($4, $5, 'WF0DXXGAKDH000004', 'Ford', 'Fiesta', 2017)
     ON CONFLICT (id) DO NOTHING`,
    [v.janeGolf, v.rajTesla, v.meiCivic, v.janeFiesta, c.jane, c.raj, c.mei],
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = createPool(loadConfig().databaseUrl);
  migrate(pool)
    .then(() => seed(pool))
    .then(() => console.log('seed complete'))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
