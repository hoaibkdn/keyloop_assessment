import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/domain/errors.js';
import {
  assertBookableWindow,
  computeSlotAvailability,
  computeWindow,
  generateSlotStarts,
  localDayBounds,
  overlaps,
  parseStartTime,
  rankBays,
  rankTechnicians,
} from '../../src/domain/scheduling.js';
import type { Dealership } from '../../src/domain/types.js';

const london: Dealership = {
  id: 'd1',
  name: 'London',
  timezone: 'Europe/London',
  opensAt: '08:00',
  closesAt: '18:00',
};
const NOW = new Date('2027-03-01T06:00:00Z');
const at = (iso: string) => new Date(iso);

describe('overlaps (half-open intervals)', () => {
  const a = { start: at('2027-03-02T09:00:00Z'), end: at('2027-03-02T10:00:00Z') };

  it('detects partial overlap', () => {
    expect(overlaps(a, { start: at('2027-03-02T09:30:00Z'), end: at('2027-03-02T10:30:00Z') })).toBe(true);
  });
  it('detects containment', () => {
    expect(overlaps(a, { start: at('2027-03-02T09:15:00Z'), end: at('2027-03-02T09:45:00Z') })).toBe(true);
    expect(overlaps({ start: at('2027-03-02T08:00:00Z'), end: at('2027-03-02T12:00:00Z') }, a)).toBe(true);
  });
  it('treats back-to-back bookings as NOT overlapping', () => {
    expect(overlaps(a, { start: at('2027-03-02T10:00:00Z'), end: at('2027-03-02T11:00:00Z') })).toBe(false);
    expect(overlaps(a, { start: at('2027-03-02T08:00:00Z'), end: at('2027-03-02T09:00:00Z') })).toBe(false);
  });
});

describe('computeWindow', () => {
  it('derives the end time from the service duration', () => {
    const w = computeWindow(at('2027-03-02T09:00:00Z'), 90);
    expect(w.end.toISOString()).toBe('2027-03-02T10:30:00.000Z');
  });
});

describe('parseStartTime', () => {
  it('accepts UTC and offset timestamps', () => {
    expect(parseStartTime('2027-03-02T09:00:00Z').toISOString()).toBe('2027-03-02T09:00:00.000Z');
    expect(parseStartTime('2027-03-02T10:00:00+01:00').toISOString()).toBe('2027-03-02T09:00:00.000Z');
  });
  it('rejects timestamps without an explicit offset (ambiguous local time)', () => {
    expect(() => parseStartTime('2027-03-02T09:00:00')).toThrow(ValidationError);
  });
  it('rejects garbage', () => {
    expect(() => parseStartTime('tomorrow at 9')).toThrow(ValidationError);
  });
});

describe('assertBookableWindow', () => {
  const ok = (iso: string, mins: number) => () => assertBookableWindow(computeWindow(at(iso), mins), london, NOW);

  it('accepts a window inside opening hours', () => {
    expect(ok('2027-03-02T09:00:00Z', 60)).not.toThrow();
  });
  it('accepts a window that ends exactly at closing time', () => {
    expect(ok('2027-03-02T17:00:00Z', 60)).not.toThrow();
  });
  it('rejects a window that runs past closing time', () => {
    expect(ok('2027-03-02T17:30:00Z', 60)).toThrow(/opening hours/);
  });
  it('rejects a window that starts before opening', () => {
    expect(ok('2027-03-02T07:45:00Z', 60)).toThrow(/opening hours/);
  });
  it('rejects bookings in the past', () => {
    expect(ok('2027-02-28T09:00:00Z', 60)).toThrow(/future/);
  });
  it('rejects bookings beyond the 90-day horizon', () => {
    expect(ok('2027-07-01T09:00:00Z', 60)).toThrow(/90 days/);
  });
  it('rejects start times not aligned to 15 minutes', () => {
    expect(ok('2027-03-02T09:10:00Z', 60)).toThrow(/15-minute/);
  });
  it('evaluates opening hours in the dealership timezone (British Summer Time)', () => {
    // 2027-06-01 London is UTC+1: 08:00 local == 07:00Z, so 07:00Z is valid and 17:30Z (18:30 local) is not.
    const summerNow = new Date('2027-05-30T00:00:00Z');
    expect(() => assertBookableWindow(computeWindow(at('2027-06-01T07:00:00Z'), 60), london, summerNow)).not.toThrow();
    expect(() => assertBookableWindow(computeWindow(at('2027-06-01T16:30:00Z'), 60), london, summerNow)).toThrow(
      /opening hours/,
    );
  });
});

describe('generateSlotStarts', () => {
  it('produces every 15-minute start that fits before closing', () => {
    const slots = generateSlotStarts('2027-03-02', london, 120);
    expect(slots[0]!.toISOString()).toBe('2027-03-02T08:00:00.000Z');
    expect(slots.at(-1)!.toISOString()).toBe('2027-03-02T16:00:00.000Z');
    // 08:00..16:00 inclusive in 15-minute steps = 8h * 4 + 1
    expect(slots).toHaveLength(33);
  });
  it('rejects malformed dates', () => {
    expect(() => generateSlotStarts('02/03/2027', london, 60)).toThrow(ValidationError);
  });
});

describe('localDayBounds', () => {
  it('returns a 23-hour day across the spring DST change', () => {
    const { start, end } = localDayBounds('2027-03-28', 'Europe/London');
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(23);
  });
});

describe('rankTechnicians', () => {
  it('prefers the least-loaded technician, breaking ties by name', () => {
    const ranked = rankTechnicians([
      { id: '3', name: 'Carol', bookedMinutes: 60 },
      { id: '2', name: 'Bob', bookedMinutes: 0 },
      { id: '1', name: 'Alice', bookedMinutes: 0 },
    ]);
    expect(ranked.map((t) => t.name)).toEqual(['Alice', 'Bob', 'Carol']);
  });
  it('does not mutate its input', () => {
    const input = [
      { id: '2', name: 'B', bookedMinutes: 10 },
      { id: '1', name: 'A', bookedMinutes: 0 },
    ];
    rankTechnicians(input);
    expect(input[0]!.name).toBe('B');
  });
});

describe('rankBays', () => {
  it('orders bays deterministically by name', () => {
    expect(rankBays([{ id: 'b', name: 'Bay 2' }, { id: 'a', name: 'Bay 1' }])[0]!.name).toBe('Bay 1');
  });
});

describe('computeSlotAvailability', () => {
  const slots = [at('2027-03-02T09:00:00Z'), at('2027-03-02T10:00:00Z'), at('2027-03-02T11:00:00Z')];
  const booked = [
    { technicianId: 't1', serviceBayId: 'b1', start: at('2027-03-02T09:00:00Z'), end: at('2027-03-02T10:00:00Z') },
  ];

  it('requires BOTH a free technician and a free bay', () => {
    // one technician, two bays: t1 busy at 09:00 → slot unavailable despite a free bay
    const result = computeSlotAvailability(slots, 60, ['t1'], ['b1', 'b2'], booked);
    expect(result.map((r) => r.available)).toEqual([false, true, true]);
    expect(result[0]).toMatchObject({ availableTechnicians: 0, availableBays: 1 });
  });

  it('is unavailable when technicians are free but every bay is taken', () => {
    const result = computeSlotAvailability(slots, 60, ['t1', 't2'], ['b1'], booked);
    expect(result[0]).toMatchObject({ available: false, availableTechnicians: 1, availableBays: 0 });
  });

  it('considers the full service duration, not just the start time', () => {
    // A 90-minute job at 08:45 would run into the 09:00 booking.
    const result = computeSlotAvailability([at('2027-03-02T08:45:00Z')], 90, ['t1'], ['b1'], booked);
    expect(result[0]!.available).toBe(false);
  });
});
