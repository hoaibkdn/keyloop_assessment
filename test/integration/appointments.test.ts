import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SEED } from '../../src/db/seed.js';
import { at, bookingBody, resetAppointments, setupTestApp, teardown, type TestContext } from './helpers.js';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestApp();
});
afterAll(async () => teardown(ctx));
beforeEach(async () => resetAppointments(ctx.pool));

const book = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'POST', url: '/appointments', payload: body, headers });

const brake = (vehicle: { customerId: string; vehicleId: string }, startTime: string) =>
  book(bookingBody({ ...vehicle, serviceTypeId: SEED.serviceTypes.brakeService, startTime }));

const JANE_GOLF = { customerId: SEED.customers.jane, vehicleId: SEED.vehicles.janeGolf };
const JANE_FIESTA = { customerId: SEED.customers.jane, vehicleId: SEED.vehicles.janeFiesta };
const RAJ_TESLA = { customerId: SEED.customers.raj, vehicleId: SEED.vehicles.rajTesla };
const MEI_CIVIC = { customerId: SEED.customers.mei, vehicleId: SEED.vehicles.meiCivic };

describe('POST /appointments – confirmed booking', () => {
  it('creates a persistent appointment linking customer, vehicle, technician and bay', async () => {
    const res = await book(bookingBody());
    expect(res.statusCode).toBe(201);
    const appt = res.json();
    expect(appt).toMatchObject({
      status: 'CONFIRMED',
      dealershipId: SEED.dealerships.london,
      customerId: SEED.customers.jane,
      vehicleId: SEED.vehicles.janeGolf,
      serviceTypeId: SEED.serviceTypes.oilChange,
      startTime: '2027-03-02T09:00:00.000Z',
      endTime: '2027-03-02T10:00:00.000Z', // 60-minute oil change
    });
    expect(appt.technicianId).toBeTruthy();
    expect(appt.serviceBayId).toBeTruthy();
    expect(res.headers.location).toBe(`/appointments/${appt.id}`);

    const fetched = await ctx.app.inject({ method: 'GET', url: `/appointments/${appt.id}` });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toEqual(appt);
  });

  it('only assigns a technician with the required skill', async () => {
    // Only Alice has BRAKES.
    const res = await brake(JANE_GOLF, at('09:00'));
    expect(res.statusCode).toBe(201);
    expect(res.json().technicianId).toBe(SEED.technicians.alice);
  });

  it('only assigns technicians and bays from the requested dealership', async () => {
    const res = await book(bookingBody({ dealershipId: SEED.dealerships.manchester, startTime: at('10:00') }));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ technicianId: SEED.technicians.dan, serviceBayId: SEED.bays.manchesterBay1 });
  });

  it('balances load by assigning the least-booked qualified technician', async () => {
    const first = await book(bookingBody({ startTime: at('09:00') }));
    const second = await book(bookingBody({ ...RAJ_TESLA, startTime: at('11:00') }));
    expect(first.json().technicianId).toBe(SEED.technicians.alice);
    expect(second.json().technicianId).toBe(SEED.technicians.bob); // Alice already has 60 min
  });
});

describe('POST /appointments – availability rules', () => {
  it('rejects when no qualified technician is free, even though bays are free', async () => {
    expect((await brake(JANE_GOLF, at('09:00'))).statusCode).toBe(201);
    const res = await brake(RAJ_TESLA, at('10:00')); // overlaps Alice's 09:00-11:00 job
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'NO_AVAILABILITY',
      details: { freeQualifiedTechnicians: 0, freeBays: 2 },
    });
  });

  it('rejects when technicians are free but every bay is occupied', async () => {
    // Add a 4th GENERAL technician so bays (3) become the bottleneck.
    await ctx.pool.query(
      `INSERT INTO technicians (id, dealership_id, name, skills)
       VALUES ('33333333-3333-4333-8333-0000000000ff', $1, 'Zed Extra', '{GENERAL}')`,
      [SEED.dealerships.london],
    );
    try {
      for (const v of [JANE_GOLF, RAJ_TESLA, MEI_CIVIC]) {
        expect((await book(bookingBody({ ...v, startTime: at('09:00') }))).statusCode).toBe(201);
      }
      const res = await book(bookingBody({ ...JANE_FIESTA, startTime: at('09:00') }));
      expect(res.statusCode).toBe(409);
      expect(res.json().error.details).toMatchObject({ freeQualifiedTechnicians: 1, freeBays: 0 });
    } finally {
      await ctx.pool.query(`DELETE FROM technicians WHERE id = '33333333-3333-4333-8333-0000000000ff'`);
    }
  });

  it('allows back-to-back bookings for the same technician', async () => {
    expect((await brake(JANE_GOLF, at('09:00'))).statusCode).toBe(201);
    const res = await brake(RAJ_TESLA, at('11:00')); // starts exactly when the first ends
    expect(res.statusCode).toBe(201);
    expect(res.json().technicianId).toBe(SEED.technicians.alice);
  });

  it('prevents the same vehicle being booked into overlapping appointments', async () => {
    expect((await book(bookingBody({ startTime: at('09:00') }))).statusCode).toBe(201);
    const res = await book(bookingBody({ startTime: at('09:30') }));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('VEHICLE_ALREADY_BOOKED');
  });
});

describe('POST /appointments – validation', () => {
  it.each([
    ['outside opening hours', { startTime: at('17:30') }, 422, 'VALIDATION_FAILED'],
    ['in the past', { startTime: '2027-02-27T09:00:00Z' }, 422, 'VALIDATION_FAILED'],
    ['not on a 15-minute boundary', { startTime: at('09:05') }, 422, 'VALIDATION_FAILED'],
    ['without a timezone offset', { startTime: '2027-03-02T09:00:00' }, 400, 'BAD_REQUEST'],
    ['vehicle owned by someone else', { customerId: SEED.customers.raj }, 422, 'VALIDATION_FAILED'],
    ['unknown dealership', { dealershipId: '11111111-1111-4111-8111-999999999999' }, 404, 'NOT_FOUND'],
    ['unknown service type', { serviceTypeId: '22222222-2222-4222-8222-999999999999' }, 404, 'NOT_FOUND'],
    ['malformed id', { vehicleId: 'not-a-uuid' }, 400, 'BAD_REQUEST'],
    ['unexpected field', { technicianId: SEED.technicians.bob }, 400, 'BAD_REQUEST'],
  ])('rejects a booking %s', async (_name, overrides, status, code) => {
    const res = await book(bookingBody(overrides));
    expect(res.statusCode).toBe(status);
    expect(res.json().error.code).toBe(code);
    expect(res.json().error.requestId).toBeTruthy();
  });

  it('rejects a missing required field', async () => {
    const { vehicleId: _omit, ...body } = bookingBody();
    const res = await book(body);
    expect(res.statusCode).toBe(400);
  });
});

describe('Idempotency-Key', () => {
  it('replays the original appointment for a retried request instead of double-booking', async () => {
    const headers = { 'idempotency-key': 'client-retry-0001' };
    const first = await book(bookingBody(), headers);
    const retry = await book(bookingBody(), headers);
    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().id).toBe(first.json().id);
    const { rows } = await ctx.pool.query('SELECT count(*)::int AS n FROM appointments');
    expect(rows[0].n).toBe(1);
  });

  it('rejects reuse of a key for a different request', async () => {
    const headers = { 'idempotency-key': 'client-retry-0002' };
    expect((await book(bookingBody(), headers)).statusCode).toBe(201);
    const res = await book(bookingBody({ startTime: at('13:00') }), headers);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

describe('Cancellation', () => {
  it('cancels an appointment and frees its technician for re-booking', async () => {
    const first = (await brake(JANE_GOLF, at('09:00'))).json();
    expect((await brake(RAJ_TESLA, at('09:00'))).statusCode).toBe(409);

    const cancel = await ctx.app.inject({ method: 'POST', url: `/appointments/${first.id}/cancel` });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json()).toMatchObject({ status: 'CANCELLED' });
    expect(cancel.json().cancelledAt).toBeTruthy();

    expect((await brake(RAJ_TESLA, at('09:00'))).statusCode).toBe(201);
  });

  it('rejects cancelling twice', async () => {
    const appt = (await book(bookingBody())).json();
    await ctx.app.inject({ method: 'POST', url: `/appointments/${appt.id}/cancel` });
    const again = await ctx.app.inject({ method: 'POST', url: `/appointments/${appt.id}/cancel` });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('INVALID_STATE');
  });

  it('returns 404 for an unknown appointment', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/appointments/00000000-0000-4000-8000-000000000000/cancel',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /appointments', () => {
  it('lists a dealership schedule filtered by time range and status', async () => {
    await book(bookingBody({ startTime: at('09:00') }));
    await book(bookingBody({ ...RAJ_TESLA, startTime: at('14:00') }));
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/appointments?dealershipId=${SEED.dealerships.london}&from=${at('12:00')}&to=${at('18:00')}&status=CONFIRMED`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
    expect(res.json()[0].vehicleId).toBe(SEED.vehicles.rajTesla);
  });
});
