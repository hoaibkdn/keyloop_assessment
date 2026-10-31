import type { Queryable } from '../db/pool.js';
import type { Dealership, ServiceType, Vehicle } from '../domain/types.js';

const DEALERSHIP_COLS = `id, name, timezone, to_char(opens_at, 'HH24:MI') AS "opensAt", to_char(closes_at, 'HH24:MI') AS "closesAt"`;
const SERVICE_TYPE_COLS = `id, code, name, duration_minutes AS "durationMinutes", required_skill AS "requiredSkill"`;

/** Read access to master data (dealerships, service types, vehicles). */
export class ReferenceRepository {
  constructor(private readonly db: Queryable) {}

  async listDealerships(): Promise<Dealership[]> {
    return (await this.db.query<Dealership>(`SELECT ${DEALERSHIP_COLS} FROM dealerships ORDER BY name`)).rows;
  }

  async findDealership(id: string): Promise<Dealership | null> {
    const res = await this.db.query<Dealership>(`SELECT ${DEALERSHIP_COLS} FROM dealerships WHERE id = $1`, [id]);
    return res.rows[0] ?? null;
  }

  async listServiceTypes(): Promise<ServiceType[]> {
    return (await this.db.query<ServiceType>(`SELECT ${SERVICE_TYPE_COLS} FROM service_types ORDER BY name`)).rows;
  }

  async findServiceType(id: string): Promise<ServiceType | null> {
    const res = await this.db.query<ServiceType>(`SELECT ${SERVICE_TYPE_COLS} FROM service_types WHERE id = $1`, [id]);
    return res.rows[0] ?? null;
  }

  async findVehicle(id: string): Promise<Vehicle | null> {
    const res = await this.db.query<Vehicle>(
      `SELECT id, customer_id AS "customerId", vin, make, model, year FROM vehicles WHERE id = $1`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  async customerExists(id: string): Promise<boolean> {
    const res = await this.db.query('SELECT 1 FROM customers WHERE id = $1', [id]);
    return (res.rowCount ?? 0) > 0;
  }
}
