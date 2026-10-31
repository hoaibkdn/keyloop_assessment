import client from 'prom-client';

/** One registry per app instance so tests can build isolated apps. */
export function createMetrics() {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });

  const httpDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [registry],
  });

  const bookings = new client.Counter({
    name: 'scheduler_booking_requests_total',
    help: 'Booking attempts by outcome (confirmed, replayed, no_availability, rejected, error)',
    labelNames: ['outcome'] as const,
    registers: [registry],
  });

  const bookingConflictRetries = new client.Counter({
    name: 'scheduler_booking_conflict_retries_total',
    help: 'Times a booking lost a race at the database constraint and was retried',
    registers: [registry],
  });

  const bookingDuration = new client.Histogram({
    name: 'scheduler_booking_duration_seconds',
    help: 'End-to-end time to process a booking request inside the service',
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    registers: [registry],
  });

  return { registry, httpDuration, bookings, bookingConflictRetries, bookingDuration };
}

export type Metrics = ReturnType<typeof createMetrics>;
