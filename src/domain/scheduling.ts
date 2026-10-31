import { DateTime } from 'luxon';
import { ValidationError } from './errors.js';
import type { BayCandidate, Dealership, TechnicianCandidate } from './types.js';

/** Appointments must start on a 15-minute boundary (documented assumption). */
export const SLOT_GRANULARITY_MINUTES = 15;
/** How far ahead customers may book. */
export const MAX_BOOKING_HORIZON_DAYS = 90;

export interface TimeWindow {
  start: Date;
  end: Date;
}

/** Half-open interval overlap: [a.start, a.end) ∩ [b.start, b.end) ≠ ∅ */
export function overlaps(a: TimeWindow, b: TimeWindow): boolean {
  return a.start < b.end && b.start < a.end;
}

export function computeWindow(start: Date, durationMinutes: number): TimeWindow {
  return { start, end: new Date(start.getTime() + durationMinutes * 60_000) };
}

/** Parses an ISO-8601 timestamp that MUST carry an explicit offset (Z or ±hh:mm). */
export function parseStartTime(value: string): Date {
  const hasOffset = /([zZ]|[+-]\d{2}:?\d{2})$/.test(value);
  const dt = DateTime.fromISO(value, { setZone: true });
  if (!hasOffset || !dt.isValid) {
    throw new ValidationError('startTime must be an ISO-8601 timestamp with a timezone offset', { startTime: value });
  }
  return dt.toJSDate();
}

function localTime(date: Date, zone: string): DateTime {
  return DateTime.fromJSDate(date, { zone });
}

function atLocalClock(day: DateTime, hhmm: string): DateTime {
  const [h = 0, m = 0, s = 0] = hhmm.split(':').map(Number);
  return day.set({ hour: h, minute: m, second: s, millisecond: 0 });
}

/**
 * Checks that a booking window is acceptable for a dealership, independent of
 * resource availability. Throws ValidationError describing the first rule broken.
 */
export function assertBookableWindow(window: TimeWindow, dealership: Dealership, now: Date = new Date()): void {
  if (window.start.getTime() <= now.getTime()) {
    throw new ValidationError('Appointments must be booked in the future');
  }
  const horizon = now.getTime() + MAX_BOOKING_HORIZON_DAYS * 24 * 60 * 60_000;
  if (window.start.getTime() > horizon) {
    throw new ValidationError(`Appointments can be booked at most ${MAX_BOOKING_HORIZON_DAYS} days ahead`);
  }

  const localStart = localTime(window.start, dealership.timezone);
  if (localStart.second !== 0 || localStart.millisecond !== 0 || localStart.minute % SLOT_GRANULARITY_MINUTES !== 0) {
    throw new ValidationError(`startTime must align to a ${SLOT_GRANULARITY_MINUTES}-minute boundary`);
  }

  const localEnd = localTime(window.end, dealership.timezone);
  const opens = atLocalClock(localStart.startOf('day'), dealership.opensAt);
  const closes = atLocalClock(localStart.startOf('day'), dealership.closesAt);
  if (localStart < opens || localEnd > closes) {
    throw new ValidationError('Appointment must start and finish within dealership opening hours', {
      opensAt: dealership.opensAt,
      closesAt: dealership.closesAt,
      timezone: dealership.timezone,
    });
  }
}

/** The [start, end) instant range of a local calendar day at the dealership. */
export function localDayBounds(date: Date | string, timezone: string): TimeWindow {
  const day =
    typeof date === 'string'
      ? DateTime.fromISO(date, { zone: timezone }).startOf('day')
      : localTime(date, timezone).startOf('day');
  if (!day.isValid) throw new ValidationError('Invalid date', { date });
  return { start: day.toJSDate(), end: day.plus({ days: 1 }).toJSDate() };
}

/** All candidate start times on a local day that fit fully inside opening hours. */
export function generateSlotStarts(
  isoDate: string,
  dealership: Dealership,
  durationMinutes: number,
  stepMinutes: number = SLOT_GRANULARITY_MINUTES,
): Date[] {
  const day = DateTime.fromISO(isoDate, { zone: dealership.timezone });
  if (!day.isValid || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    throw new ValidationError('date must be in YYYY-MM-DD format', { date: isoDate });
  }
  const opens = atLocalClock(day, dealership.opensAt);
  const closes = atLocalClock(day, dealership.closesAt);
  const slots: Date[] = [];
  for (let t = opens; t.plus({ minutes: durationMinutes }) <= closes; t = t.plus({ minutes: stepMinutes })) {
    slots.push(t.toJSDate());
  }
  return slots;
}

/**
 * Picks the technician with the lightest load that day to spread work fairly;
 * ties are broken by name then id so the choice is deterministic.
 */
export function rankTechnicians(candidates: readonly TechnicianCandidate[]): TechnicianCandidate[] {
  return [...candidates].sort(
    (a, b) => a.bookedMinutes - b.bookedMinutes || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}

export function rankBays(candidates: readonly BayCandidate[]): BayCandidate[] {
  return [...candidates].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export interface BookedInterval extends TimeWindow {
  technicianId: string;
  serviceBayId: string;
}

export interface SlotAvailability {
  startTime: Date;
  endTime: Date;
  availableTechnicians: number;
  availableBays: number;
  available: boolean;
}

/**
 * Pure availability calculation for a set of candidate slots: a slot is bookable
 * only when at least one qualified technician AND one bay are free for its whole
 * duration.
 */
export function computeSlotAvailability(
  slotStarts: readonly Date[],
  durationMinutes: number,
  technicianIds: readonly string[],
  bayIds: readonly string[],
  booked: readonly BookedInterval[],
): SlotAvailability[] {
  return slotStarts.map((start) => {
    const window = computeWindow(start, durationMinutes);
    const clashing = booked.filter((b) => overlaps(window, b));
    const busyTechs = new Set(clashing.map((b) => b.technicianId));
    const busyBays = new Set(clashing.map((b) => b.serviceBayId));
    const availableTechnicians = technicianIds.filter((id) => !busyTechs.has(id)).length;
    const availableBays = bayIds.filter((id) => !busyBays.has(id)).length;
    return {
      startTime: window.start,
      endTime: window.end,
      availableTechnicians,
      availableBays,
      available: availableTechnicians > 0 && availableBays > 0,
    };
  });
}
