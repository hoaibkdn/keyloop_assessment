import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SEED } from '../../src/db/seed.js';
import { at, bookingBody, resetAppointments, setupTestApp, teardown, type TestContext } from './helpers.js';

let ctx: TestContext;
const EXTRA_VEHICLES = 12;
const vehicleId = (i: number) => `77777777-7777-4777-8777-${String(i).padStart(12, '0')}`;

beforeAll(async () => {
  ctx = await setupTestApp();
  for (let i = 0; i < EXTRA_VEHICLES; i++) {
    await ctx.pool.query(
      `INSERT INTO vehicles (id, customer_id, vin, make, model, year) VALUES ($1, $2, $3, 'Test', 'Car', 2020)`,
      [vehicleId(i), SEED.customers.mei, `TESTVIN${String(i).padStart(10, '0')}`],
    );
  }
});
afterAll(async () => teardown(ctx));
beforeEach(async () => resetAppointments(ctx.pool));

describe('concurrent booking race', () => {
  it('never double-books: N simultaneous requests for one slot yield exactly min(techs, bays) bookings', async () => {
    // London has 3 GENERAL technicians and 3 bays → capacity of 3 concurrent oil changes.
    const responses = await Promise.all(
      Array.from({ length: EXTRA_VEHICLES }, (_, i) =>
        ctx.app.inject({
          method: 'POST',
          url: '/appointments',
          payload: bookingBody({ customerId: SEED.customers.mei, vehicleId: vehicleId(i), startTime: at('09:00') }),
        }),
      ),
    );

    const statuses = responses.map((r) => r.statusCode);
    expect(statuses.filter((s) => s >= 500)).toEqual([]); // deadlocks must never surface as 500s
    expect(statuses.filter((s) => s === 201)).toHaveLength(3);
    expect(statuses.filter((s) => s === 409)).toHaveLength(EXTRA_VEHICLES - 3);
    responses
      .filter((r) => r.statusCode === 409)
      .forEach((r) => expect(r.json().error.code).toBe('NO_AVAILABILITY'));

    const confirmed = responses.filter((r) => r.statusCode === 201).map((r) => r.json());
    expect(new Set(confirmed.map((a) => a.technicianId)).size).toBe(3);
    expect(new Set(confirmed.map((a) => a.serviceBayId)).size).toBe(3);

    // Belt and braces: ask the database directly for any overlapping pairs.
    const { rows } = await ctx.pool.query(`
      SELECT count(*)::int AS n FROM appointments a JOIN appointments b
        ON a.id < b.id AND a.status = 'CONFIRMED' AND b.status = 'CONFIRMED'
       AND tstzrange(a.start_time, a.end_time) && tstzrange(b.start_time, b.end_time)
       AND (a.technician_id = b.technician_id OR a.service_bay_id = b.service_bay_id)`);
    expect(rows[0].n).toBe(0);
  });

  it('concurrent retries with one Idempotency-Key create exactly one appointment', async () => {
    const payload = bookingBody({ customerId: SEED.customers.mei, vehicleId: vehicleId(0), startTime: at('10:00') });
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        ctx.app.inject({ method: 'POST', url: '/appointments', payload, headers: { 'idempotency-key': 'dup-key-123' } }),
      ),
    );
    const ids = new Set(responses.map((r) => r.json().id));
    expect(responses.every((r) => r.statusCode === 201 || r.statusCode === 200)).toBe(true);
    expect(ids.size).toBe(1);
    const { rows } = await ctx.pool.query('SELECT count(*)::int AS n FROM appointments');
    expect(rows[0].n).toBe(1);
  });
});

describe('database-level invariants (defence in depth)', () => {
  const insert = (vehicle: string, tech: string, bay: string, start: string, end: string) =>
    ctx.pool.query(
      `INSERT INTO appointments (dealership_id, customer_id, vehicle_id, service_type_id, technician_id, service_bay_id, start_time, end_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [SEED.dealerships.london, SEED.customers.mei, vehicle, SEED.serviceTypes.oilChange, tech, bay, start, end],
    );

  it('rejects overlapping rows for one technician even when the application is bypassed', async () => {
    await insert(vehicleId(0), SEED.technicians.alice, SEED.bays.bay1, at('09:00'), at('10:00'));
    await expect(
      insert(vehicleId(1), SEED.technicians.alice, SEED.bays.bay2, at('09:30'), at('10:30')),
    ).rejects.toMatchObject({ code: '23P01', constraint: 'no_technician_double_booking' });
  });

  it('rejects overlapping rows for one bay even when the application is bypassed', async () => {
    await insert(vehicleId(0), SEED.technicians.alice, SEED.bays.bay1, at('09:00'), at('10:00'));
    await expect(
      insert(vehicleId(1), SEED.technicians.bob, SEED.bays.bay1, at('09:45'), at('10:45')),
    ).rejects.toMatchObject({ code: '23P01', constraint: 'no_bay_double_booking' });
  });

  it('ignores cancelled appointments when enforcing overlaps', async () => {
    await insert(vehicleId(0), SEED.technicians.alice, SEED.bays.bay1, at('09:00'), at('10:00'));
    await ctx.pool.query(`UPDATE appointments SET status = 'CANCELLED'`);
    await expect(
      insert(vehicleId(1), SEED.technicians.alice, SEED.bays.bay1, at('09:00'), at('10:00')),
    ).resolves.toBeDefined();
  });
});
