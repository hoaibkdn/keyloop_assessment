import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SEED } from '../../src/db/seed.js';
import { at, bookingBody, DAY, resetAppointments, setupTestApp, teardown, type TestContext } from './helpers.js';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestApp();
});
afterAll(async () => teardown(ctx));
beforeEach(async () => resetAppointments(ctx.pool));

const availability = (serviceTypeId: string, date = DAY) =>
  ctx.app.inject({
    method: 'GET',
    url: `/dealerships/${SEED.dealerships.london}/availability?serviceTypeId=${serviceTypeId}&date=${date}`,
  });

describe('GET /dealerships/:id/availability', () => {
  it('reflects existing bookings in real time', async () => {
    const before = (await availability(SEED.serviceTypes.brakeService)).json();
    const slot = (body: { slots: { startTime: string; available: boolean }[] }, iso: string) =>
      body.slots.find((s) => s.startTime === iso);
    expect(slot(before, '2027-03-02T09:00:00.000Z')?.available).toBe(true);

    await ctx.app.inject({
      method: 'POST',
      url: '/appointments',
      payload: bookingBody({ serviceTypeId: SEED.serviceTypes.brakeService, startTime: at('09:00') }),
    });

    const after = (await availability(SEED.serviceTypes.brakeService)).json();
    expect(slot(after, '2027-03-02T09:00:00.000Z')).toMatchObject({ available: false, availableTechnicians: 0 });
    expect(slot(after, '2027-03-02T10:45:00.000Z')?.available).toBe(false); // would overlap until 11:00
    expect(slot(after, '2027-03-02T11:00:00.000Z')?.available).toBe(true);
  });

  it('only offers slots that finish before closing', async () => {
    const body = (await availability(SEED.serviceTypes.brakeService)).json();
    expect(body.slots.at(-1).startTime).toBe('2027-03-02T16:00:00.000Z');
  });

  it('returns 404 for an unknown service type and 400 for a bad date', async () => {
    expect((await availability('22222222-2222-4222-8222-999999999999')).statusCode).toBe(404);
    expect((await availability(SEED.serviceTypes.oilChange, '2027/03/02')).statusCode).toBe(400);
  });
});

describe('catalog and ops endpoints', () => {
  it('lists dealerships and service types', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/dealerships' })).json()).toHaveLength(2);
    const types = (await ctx.app.inject({ method: 'GET', url: '/service-types' })).json();
    expect(types.find((t: { code: string }) => t.code === 'BRAKE_SERVICE')).toMatchObject({
      durationMinutes: 120,
      requiredSkill: 'BRAKES',
    });
  });

  it('reports readiness against the database', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.json()).toEqual({ status: 'ok', database: 'up' });
  });

  it('exposes booking metrics in Prometheus format', async () => {
    const confirmedCount = async () => {
      const body = (await ctx.app.inject({ method: 'GET', url: '/metrics' })).body;
      return Number(/scheduler_booking_requests_total\{outcome="confirmed"\} (\d+)/.exec(body)?.[1] ?? 0);
    };
    const before = await confirmedCount();
    await ctx.app.inject({ method: 'POST', url: '/appointments', payload: bookingBody({ startTime: at('15:00') }) });
    expect(await confirmedCount()).toBe(before + 1);
    const res = await ctx.app.inject({ method: 'GET', url: '/metrics' });
    expect(res.body).toContain('http_request_duration_seconds_bucket');
  });

  it('propagates an incoming x-request-id', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/health/live', headers: { 'x-request-id': 'trace-abc' } });
    expect(res.headers['x-request-id']).toBe('trace-abc');
  });

  it('serves the OpenAPI document', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().paths)).toContain('/appointments');
  });
});
