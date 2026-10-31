import type { FastifyInstance } from 'fastify';
import type { BookingService } from '../services/booking-service.js';
import * as S from './schemas.js';

export function registerCatalogRoutes(app: FastifyInstance, service: BookingService): void {
  app.get(
    '/dealerships',
    {
      schema: {
        tags: ['catalog'],
        summary: 'List dealerships',
        response: { 200: { type: 'array', items: S.dealership } },
      },
    },
    async () => service.listDealerships(),
  );

  app.get(
    '/service-types',
    {
      schema: {
        tags: ['catalog'],
        summary: 'List service types with duration and required technician skill',
        response: { 200: { type: 'array', items: S.serviceType } },
      },
    },
    async () => service.listServiceTypes(),
  );

  app.get<{ Params: { id: string }; Querystring: { serviceTypeId: string; date: string } }>(
    '/dealerships/:id/availability',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Real-time availability grid for a service type on a given day',
        params: S.idParams,
        querystring: S.availabilityQuery,
        response: { 200: S.availabilityResponse, 404: S.errorResponse, 422: S.errorResponse },
      },
    },
    async (request) => {
      const { serviceTypeId, date } = request.query;
      const slots = await service.getAvailability(request.params.id, serviceTypeId, date);
      return { dealershipId: request.params.id, serviceTypeId, date, slots };
    },
  );
}
