import type { FastifyInstance } from 'fastify';
import type { BookingRequest } from '../domain/types.js';
import { parseStartTime } from '../domain/scheduling.js';
import type { BookingService } from '../services/booking-service.js';
import * as S from './schemas.js';

export function registerAppointmentRoutes(app: FastifyInstance, service: BookingService): void {
  app.post<{ Body: BookingRequest; Headers: { 'idempotency-key'?: string } }>(
    '/appointments',
    {
      schema: {
        tags: ['appointments'],
        summary: 'Book a service appointment',
        description:
          'Checks that a qualified technician and a service bay are both free for the full service duration, ' +
          'auto-assigns them, and persists a CONFIRMED appointment.',
        headers: S.idempotencyHeaders,
        body: S.createAppointmentBody,
        response: {
          201: S.appointment,
          200: { ...S.appointment, description: 'Idempotent replay of an earlier identical request' },
          400: S.errorResponse,
          404: S.errorResponse,
          409: S.errorResponse,
          422: S.errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { appointment, replayed } = await service.book(request.body, request.headers['idempotency-key']);
      reply.header('location', `/appointments/${appointment.id}`);
      return reply.code(replayed ? 200 : 201).send(appointment);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/appointments/:id',
    {
      schema: {
        tags: ['appointments'],
        summary: 'Get an appointment',
        params: S.idParams,
        response: { 200: S.appointment, 404: S.errorResponse },
      },
    },
    async (request) => service.getAppointment(request.params.id),
  );

  app.get<{
    Querystring: {
      dealershipId?: string;
      vehicleId?: string;
      from?: string;
      to?: string;
      status?: 'CONFIRMED' | 'CANCELLED';
      limit: number;
    };
  }>(
    '/appointments',
    {
      schema: {
        tags: ['appointments'],
        summary: 'List appointments (e.g. a dealership schedule)',
        querystring: S.listAppointmentsQuery,
        response: { 200: { type: 'array', items: S.appointment } },
      },
    },
    async (request) => {
      const q = request.query;
      return service.listAppointments({
        dealershipId: q.dealershipId,
        vehicleId: q.vehicleId,
        from: q.from ? parseStartTime(q.from) : undefined,
        to: q.to ? parseStartTime(q.to) : undefined,
        status: q.status,
        limit: q.limit,
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/appointments/:id/cancel',
    {
      schema: {
        tags: ['appointments'],
        summary: 'Cancel an appointment, releasing its technician and bay',
        params: S.idParams,
        response: { 200: S.appointment, 404: S.errorResponse, 409: S.errorResponse },
      },
    },
    async (request) => service.cancelAppointment(request.params.id),
  );
}
