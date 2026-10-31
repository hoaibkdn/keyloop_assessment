import type { Queryable } from '../db/pool.js';
import type { Appointment } from '../domain/types.js';

const COLS = `id, dealership_id AS "dealershipId", customer_id AS "customerId", vehicle_id AS "vehicleId",
  service_type_id AS "serviceTypeId", technician_id AS "technicianId", service_bay_id AS "serviceBayId",
  start_time AS "startTime", end_time AS "endTime", status, notes, created_at AS "createdAt",
  cancelled_at AS "cancelledAt"`;

export interface NewAppointment {
  dealershipId: string;
  customerId: string;
  vehicleId: string;
  serviceTypeId: string;
  technicianId: string;
  serviceBayId: string;
  startTime: Date;
  endTime: Date;
  notes: string | null;
  idempotencyKey: string | null;
}

export interface AppointmentQuery {
  dealershipId?: string;
  vehicleId?: string;
  from?: Date;
  to?: Date;
  status?: 'CONFIRMED' | 'CANCELLED';
  limit: number;
}

export class AppointmentRepository {
  constructor(private readonly db: Queryable) {}

  async insert(a: NewAppointment): Promise<Appointment> {
    const res = await this.db.query<Appointment>(
      `INSERT INTO appointments
         (dealership_id, customer_id, vehicle_id, service_type_id, technician_id, service_bay_id,
          start_time, end_time, notes, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${COLS}`,
      [
        a.dealershipId, a.customerId, a.vehicleId, a.serviceTypeId, a.technicianId, a.serviceBayId,
        a.startTime, a.endTime, a.notes, a.idempotencyKey,
      ],
    );
    return res.rows[0]!;
  }

  async findById(id: string): Promise<Appointment | null> {
    const res = await this.db.query<Appointment>(`SELECT ${COLS} FROM appointments WHERE id = $1`, [id]);
    return res.rows[0] ?? null;
  }

  async findByIdempotencyKey(key: string): Promise<Appointment | null> {
    const res = await this.db.query<Appointment>(`SELECT ${COLS} FROM appointments WHERE idempotency_key = $1`, [key]);
    return res.rows[0] ?? null;
  }

  async list(q: AppointmentQuery): Promise<Appointment[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.dealershipId) add('dealership_id = ?', q.dealershipId);
    if (q.vehicleId) add('vehicle_id = ?', q.vehicleId);
    if (q.from) add('end_time > ?', q.from);
    if (q.to) add('start_time < ?', q.to);
    if (q.status) add('status = ?', q.status);
    params.push(q.limit);
    const res = await this.db.query<Appointment>(
      `SELECT ${COLS} FROM appointments
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY start_time, id
        LIMIT $${params.length}`,
      params,
    );
    return res.rows;
  }

  /** Cancels a confirmed appointment; returns null if it was not CONFIRMED. */
  async cancel(id: string): Promise<Appointment | null> {
    const res = await this.db.query<Appointment>(
      `UPDATE appointments SET status = 'CANCELLED', cancelled_at = now()
        WHERE id = $1 AND status = 'CONFIRMED'
        RETURNING ${COLS}`,
      [id],
    );
    return res.rows[0] ?? null;
  }
}
