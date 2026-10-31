import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { buildApp } from '../../src/app.js';
import { migrate } from '../../src/db/migrate.js';
import { createPool } from '../../src/db/pool.js';
import { SEED, seed } from '../../src/db/seed.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://scheduler:scheduler@localhost:5432/scheduler_test';

/** Fixed "now" so tests are deterministic: Monday 1 March 2027, 06:00 UTC. */
export const FIXED_NOW = new Date('2027-03-01T06:00:00Z');
/** A Tuesday inside the booking horizon; London is on GMT (UTC+0) that day. */
export const DAY = '2027-03-02';
export const at = (hhmm: string) => `${DAY}T${hhmm}:00Z`;

export interface TestContext {
  app: FastifyInstance;
  pool: pg.Pool;
}

export async function setupTestApp(): Promise<TestContext> {
  const pool = createPool(TEST_DATABASE_URL);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(pool, () => undefined);
  await seed(pool);
  const app = await buildApp({ pool, logger: false, clock: () => FIXED_NOW });
  await app.ready();
  return { app, pool };
}

export async function resetAppointments(pool: pg.Pool): Promise<void> {
  await pool.query('TRUNCATE appointments');
}

export async function teardown(ctx: TestContext): Promise<void> {
  await ctx.app.close();
  await ctx.pool.end();
}

export function bookingBody(overrides: Record<string, unknown> = {}) {
  return {
    dealershipId: SEED.dealerships.london,
    customerId: SEED.customers.jane,
    vehicleId: SEED.vehicles.janeGolf,
    serviceTypeId: SEED.serviceTypes.oilChange,
    startTime: at('09:00'),
    ...overrides,
  };
}
