import type { Queryable } from '../db/pool.js';
import type { BookedInterval, TimeWindow } from '../domain/scheduling.js';
import type { BayCandidate, TechnicianCandidate } from '../domain/types.js';

/** Queries about technicians and service bays and when they are busy. */
export class ResourceRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Active technicians at the dealership holding `skill` with no confirmed
   * appointment overlapping `window`, plus how many minutes they already have
   * booked within `day` (used for load balancing).
   */
  async findFreeTechnicians(
    dealershipId: string,
    skill: string,
    window: TimeWindow,
    day: TimeWindow,
  ): Promise<TechnicianCandidate[]> {
    const res = await this.db.query<TechnicianCandidate>(
      `SELECT t.id, t.name,
              COALESCE((
                SELECT SUM(EXTRACT(EPOCH FROM (a.end_time - a.start_time)) / 60)::int
                  FROM appointments a
                 WHERE a.technician_id = t.id AND a.status = 'CONFIRMED'
                   AND tstzrange(a.start_time, a.end_time, '[)') && tstzrange($5, $6, '[)')
              ), 0) AS "bookedMinutes"
         FROM technicians t
        WHERE t.dealership_id = $1 AND t.active AND $2 = ANY(t.skills)
          AND NOT EXISTS (
            SELECT 1 FROM appointments a
             WHERE a.technician_id = t.id AND a.status = 'CONFIRMED'
               AND tstzrange(a.start_time, a.end_time, '[)') && tstzrange($3, $4, '[)')
          )`,
      [dealershipId, skill, window.start, window.end, day.start, day.end],
    );
    return res.rows;
  }

  async findFreeBays(dealershipId: string, window: TimeWindow): Promise<BayCandidate[]> {
    const res = await this.db.query<BayCandidate>(
      `SELECT b.id, b.name
         FROM service_bays b
        WHERE b.dealership_id = $1 AND b.active
          AND NOT EXISTS (
            SELECT 1 FROM appointments a
             WHERE a.service_bay_id = b.id AND a.status = 'CONFIRMED'
               AND tstzrange(a.start_time, a.end_time, '[)') && tstzrange($2, $3, '[)')
          )`,
      [dealershipId, window.start, window.end],
    );
    return res.rows;
  }

  async listQualifiedTechnicianIds(dealershipId: string, skill: string): Promise<string[]> {
    const res = await this.db.query<{ id: string }>(
      'SELECT id FROM technicians WHERE dealership_id = $1 AND active AND $2 = ANY(skills)',
      [dealershipId, skill],
    );
    return res.rows.map((r) => r.id);
  }

  async listBayIds(dealershipId: string): Promise<string[]> {
    const res = await this.db.query<{ id: string }>(
      'SELECT id FROM service_bays WHERE dealership_id = $1 AND active',
      [dealershipId],
    );
    return res.rows.map((r) => r.id);
  }

  async listBookedIntervals(dealershipId: string, range: TimeWindow): Promise<BookedInterval[]> {
    const res = await this.db.query<BookedInterval>(
      `SELECT technician_id AS "technicianId", service_bay_id AS "serviceBayId", start_time AS start, end_time AS end
         FROM appointments
        WHERE dealership_id = $1 AND status = 'CONFIRMED'
          AND tstzrange(start_time, end_time, '[)') && tstzrange($2, $3, '[)')`,
      [dealershipId, range.start, range.end],
    );
    return res.rows;
  }
}
