import type pg from 'pg';
import { withTransaction } from '../db/pool.js';
import {
  IdempotencyConflictError,
  InvalidStateError,
  NoAvailabilityError,
  NotFoundError,
  ValidationError,
  VehicleAlreadyBookedError,
} from '../domain/errors.js';
import {
  assertBookableWindow,
  computeSlotAvailability,
  computeWindow,
  generateSlotStarts,
  localDayBounds,
  parseStartTime,
  rankBays,
  rankTechnicians,
  type SlotAvailability,
} from '../domain/scheduling.js';
import type { Appointment, BookingRequest, Dealership, ServiceType } from '../domain/types.js';
import type { Metrics } from '../observability/metrics.js';
import { AppointmentRepository, type AppointmentQuery } from '../repositories/appointment-repository.js';
import { ReferenceRepository } from '../repositories/reference-repository.js';
import { ResourceRepository } from '../repositories/resource-repository.js';

const PG_EXCLUSION_VIOLATION = '23P01';
const PG_UNIQUE_VIOLATION = '23505';
const PG_DEADLOCK_DETECTED = '40P01';
const MAX_BOOKING_ATTEMPTS = 3;

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

export interface BookingResult {
  appointment: Appointment;
  /** True when an earlier request with the same Idempotency-Key is being replayed. */
  replayed: boolean;
}

export interface BookingServiceDeps {
  pool: pg.Pool;
  metrics: Metrics;
  logger: Logger;
  clock?: () => Date;
}

function pgCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}

function pgConstraint(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'constraint' in err
    ? String((err as { constraint: unknown }).constraint)
    : undefined;
}

export class BookingService {
  private readonly pool: pg.Pool;
  private readonly refs: ReferenceRepository;
  private readonly resources: ResourceRepository;
  private readonly appointments: AppointmentRepository;
  private readonly metrics: Metrics;
  private readonly logger: Logger;
  private readonly clock: () => Date;

  constructor(deps: BookingServiceDeps) {
    this.pool = deps.pool;
    this.refs = new ReferenceRepository(deps.pool);
    this.resources = new ResourceRepository(deps.pool);
    this.appointments = new AppointmentRepository(deps.pool);
    this.metrics = deps.metrics;
    this.logger = deps.logger;
    this.clock = deps.clock ?? (() => new Date());
  }

  listDealerships() {
    return this.refs.listDealerships();
  }

  listServiceTypes() {
    return this.refs.listServiceTypes();
  }

  async getAppointment(id: string): Promise<Appointment> {
    const appt = await this.appointments.findById(id);
    if (!appt) throw new NotFoundError('Appointment not found', { id });
    return appt;
  }

  listAppointments(q: AppointmentQuery): Promise<Appointment[]> {
    return this.appointments.list(q);
  }

  async cancelAppointment(id: string): Promise<Appointment> {
    const cancelled = await this.appointments.cancel(id);
    if (cancelled) {
      this.logger.info({ appointmentId: id }, 'appointment cancelled');
      return cancelled;
    }
    const existing = await this.appointments.findById(id);
    if (!existing) throw new NotFoundError('Appointment not found', { id });
    throw new InvalidStateError(`Appointment is already ${existing.status}`, { id, status: existing.status });
  }

  /** Availability grid for one local day: which start times can currently be booked. */
  async getAvailability(dealershipId: string, serviceTypeId: string, date: string): Promise<SlotAvailability[]> {
    const { dealership, serviceType } = await this.loadDealershipAndServiceType(dealershipId, serviceTypeId);
    const now = this.clock();
    const slots = generateSlotStarts(date, dealership, serviceType.durationMinutes).filter((s) => s > now);
    if (slots.length === 0) return [];
    const day = localDayBounds(date, dealership.timezone);
    const [techIds, bayIds, booked] = await Promise.all([
      this.resources.listQualifiedTechnicianIds(dealershipId, serviceType.requiredSkill),
      this.resources.listBayIds(dealershipId),
      this.resources.listBookedIntervals(dealershipId, day),
    ]);
    return computeSlotAvailability(slots, serviceType.durationMinutes, techIds, bayIds, booked);
  }

  /**
   * Books an appointment, auto-assigning a qualified technician and a bay that
   * are both free for the full service duration.
   *
   * Concurrency, in two layers:
   *  1. A transaction-scoped advisory lock per dealership serialises the
   *     read-free-resources-then-insert critical section, so concurrent requests
   *     at one dealership never pick the same technician/bay from a stale read.
   *     Different dealerships still book fully in parallel.
   *  2. GiST exclusion constraints are the authoritative invariant. If anything
   *     slips past the lock (e.g. the same vehicle booked at two dealerships at
   *     once), the insert fails with 23P01, or 40P01 if Postgres resolves a
   *     constraint-wait deadlock, and we re-read and retry.
   */
  async book(req: BookingRequest, idempotencyKey?: string): Promise<BookingResult> {
    const endTimer = this.metrics.bookingDuration.startTimer();
    try {
      const result = await this.bookInner(req, idempotencyKey);
      this.metrics.bookings.inc({ outcome: result.replayed ? 'replayed' : 'confirmed' });
      return result;
    } catch (err) {
      const outcome =
        err instanceof NoAvailabilityError
          ? 'no_availability'
          : err instanceof ValidationError || err instanceof NotFoundError || err instanceof VehicleAlreadyBookedError
            ? 'rejected'
            : 'error';
      this.metrics.bookings.inc({ outcome });
      throw err;
    } finally {
      endTimer();
    }
  }

  private async bookInner(req: BookingRequest, idempotencyKey?: string): Promise<BookingResult> {
    const start = parseStartTime(req.startTime);

    if (idempotencyKey) {
      const existing = await this.appointments.findByIdempotencyKey(idempotencyKey);
      if (existing) return { appointment: this.assertSameRequest(existing, req, start), replayed: true };
    }

    const { dealership, serviceType } = await this.loadDealershipAndServiceType(req.dealershipId, req.serviceTypeId);
    const vehicle = await this.refs.findVehicle(req.vehicleId);
    if (!vehicle) throw new NotFoundError('Vehicle not found', { vehicleId: req.vehicleId });
    if (!(await this.refs.customerExists(req.customerId))) {
      throw new NotFoundError('Customer not found', { customerId: req.customerId });
    }
    if (vehicle.customerId !== req.customerId) {
      throw new ValidationError('Vehicle does not belong to this customer', {
        vehicleId: vehicle.id,
        customerId: req.customerId,
      });
    }

    const window = computeWindow(start, serviceType.durationMinutes);
    assertBookableWindow(window, dealership, this.clock());
    const day = localDayBounds(window.start, dealership.timezone);

    for (let attempt = 1; attempt <= MAX_BOOKING_ATTEMPTS; attempt++) {
      try {
        const appointment = await withTransaction(this.pool, async (tx) => {
          await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [dealership.id]);
          const resources = new ResourceRepository(tx);
          const [techs, bays] = await Promise.all([
            resources.findFreeTechnicians(dealership.id, serviceType.requiredSkill, window, day),
            resources.findFreeBays(dealership.id, window),
          ]);
          const tech = rankTechnicians(techs)[0];
          const bay = rankBays(bays)[0];
          if (!tech || !bay) {
            throw new NoAvailabilityError('No qualified technician and service bay are both free for that time', {
              freeQualifiedTechnicians: techs.length,
              freeBays: bays.length,
              startTime: window.start.toISOString(),
              endTime: window.end.toISOString(),
            });
          }
          return new AppointmentRepository(tx).insert({
            dealershipId: dealership.id,
            customerId: req.customerId,
            vehicleId: vehicle.id,
            serviceTypeId: serviceType.id,
            technicianId: tech.id,
            serviceBayId: bay.id,
            startTime: window.start,
            endTime: window.end,
            notes: req.notes ?? null,
            idempotencyKey: idempotencyKey ?? null,
          });
        });
        this.logger.info(
          {
            appointmentId: appointment.id,
            dealershipId: appointment.dealershipId,
            technicianId: appointment.technicianId,
            serviceBayId: appointment.serviceBayId,
            startTime: appointment.startTime,
            attempt,
          },
          'appointment confirmed',
        );
        return { appointment, replayed: false };
      } catch (err) {
        const code = pgCode(err);
        const constraint = pgConstraint(err);
        if (code === PG_EXCLUSION_VIOLATION && constraint === 'no_vehicle_double_booking') {
          throw new VehicleAlreadyBookedError('This vehicle already has an appointment overlapping that time', {
            vehicleId: vehicle.id,
          });
        }
        const retryable = code === PG_EXCLUSION_VIOLATION || code === PG_DEADLOCK_DETECTED;
        if (retryable && attempt < MAX_BOOKING_ATTEMPTS) {
          this.metrics.bookingConflictRetries.inc();
          this.logger.warn({ attempt, code, constraint }, 'booking lost a race for a resource; retrying');
          continue;
        }
        if (retryable) {
          throw new NoAvailabilityError('Resources were taken by concurrent bookings; please choose another time');
        }
        if (code === PG_UNIQUE_VIOLATION && idempotencyKey && constraint === 'appointments_idempotency_key_key') {
          // A concurrent request with the same key won; replay its result.
          const existing = await this.appointments.findByIdempotencyKey(idempotencyKey);
          if (existing) return { appointment: this.assertSameRequest(existing, req, start), replayed: true };
        }
        throw err;
      }
    }
    /* c8 ignore next */
    throw new Error('unreachable');
  }

  private assertSameRequest(existing: Appointment, req: BookingRequest, start: Date): Appointment {
    const same =
      existing.dealershipId === req.dealershipId &&
      existing.customerId === req.customerId &&
      existing.vehicleId === req.vehicleId &&
      existing.serviceTypeId === req.serviceTypeId &&
      existing.startTime.getTime() === start.getTime();
    if (!same) {
      throw new IdempotencyConflictError('Idempotency-Key was already used for a different booking request');
    }
    return existing;
  }

  private async loadDealershipAndServiceType(
    dealershipId: string,
    serviceTypeId: string,
  ): Promise<{ dealership: Dealership; serviceType: ServiceType }> {
    const [dealership, serviceType] = await Promise.all([
      this.refs.findDealership(dealershipId),
      this.refs.findServiceType(serviceTypeId),
    ]);
    if (!dealership) throw new NotFoundError('Dealership not found', { dealershipId });
    if (!serviceType) throw new NotFoundError('Service type not found', { serviceTypeId });
    return { dealership, serviceType };
  }
}
