import { randomUUID } from 'node:crypto';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type pg from 'pg';
import { DomainError } from './domain/errors.js';
import { createMetrics } from './observability/metrics.js';
import { registerAppointmentRoutes } from './routes/appointments.js';
import { registerCatalogRoutes } from './routes/catalog.js';
import { BookingService } from './services/booking-service.js';

export interface BuildAppOptions {
  pool: pg.Pool;
  logger?: FastifyServerOptions['logger'];
  clock?: () => Date;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? { level: 'info' },
    // Propagate an incoming correlation id, or mint one, so logs can be joined across services.
    genReqId: (req) => {
      const header = req.headers['x-request-id'];
      return typeof header === 'string' && header.length > 0 && header.length <= 128 ? header : randomUUID();
    },
    ajv: { customOptions: { removeAdditional: false, coerceTypes: 'array', useDefaults: true } },
  });

  const metrics = createMetrics();
  const service = new BookingService({ pool: opts.pool, metrics, logger: app.log, clock: opts.clock });

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'Keyloop Unified Service Scheduler API',
        version: '1.0.0',
        description: 'Resource-constrained service appointment booking (technician + service bay).',
      },
      tags: [
        { name: 'appointments', description: 'Booking lifecycle' },
        { name: 'catalog', description: 'Dealerships, service types and availability' },
        { name: 'ops', description: 'Health and metrics' },
      ],
    },
  });
  await app.register(fastifySwaggerUi, { routePrefix: '/docs' });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
  app.addHook('onResponse', async (request, reply) => {
    metrics.httpDuration
      .labels(request.method, request.routeOptions.url ?? 'unmatched', String(reply.statusCode))
      .observe(reply.elapsedTime / 1000);
  });

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof DomainError) {
      request.log.info({ code: err.code, details: err.details }, err.message);
      return reply
        .code(err.statusCode)
        .send({ error: { code: err.code, message: err.message, details: err.details, requestId: request.id } });
    }
    const e = err as { validation?: unknown; statusCode?: number; message: string };
    if (e.validation) {
      return reply
        .code(400)
        .send({ error: { code: 'BAD_REQUEST', message: e.message, requestId: request.id } });
    }
    if (e.statusCode && e.statusCode < 500) {
      return reply.code(e.statusCode).send({ error: { code: 'BAD_REQUEST', message: e.message, requestId: request.id } });
    }
    request.log.error({ err }, 'unhandled error');
    return reply
      .code(500)
      .send({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId: request.id } });
  });

  app.get('/health/live', { schema: { tags: ['ops'], summary: 'Liveness probe' } }, async () => ({ status: 'ok' }));
  app.get('/health/ready', { schema: { tags: ['ops'], summary: 'Readiness probe (checks database)' } }, async (_req, reply) => {
    try {
      await opts.pool.query('SELECT 1');
      return { status: 'ok', database: 'up' };
    } catch {
      return reply.code(503).send({ status: 'unavailable', database: 'down' });
    }
  });
  app.get('/metrics', { schema: { tags: ['ops'], summary: 'Prometheus metrics', hide: false } }, async (_req, reply) => {
    reply.header('content-type', metrics.registry.contentType);
    return metrics.registry.metrics();
  });

  registerCatalogRoutes(app, service);
  registerAppointmentRoutes(app, service);

  return app;
}
