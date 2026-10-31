// JSON Schemas double as request validation (Ajv) and OpenAPI documentation.

const uuid = { type: 'string', format: 'uuid' } as const;
const dateTime = { type: 'string', format: 'date-time' } as const;

export const errorResponse = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        details: { type: 'object', additionalProperties: true },
        requestId: { type: 'string' },
      },
      required: ['code', 'message'],
    },
  },
} as const;

export const appointment = {
  type: 'object',
  properties: {
    id: uuid,
    dealershipId: uuid,
    customerId: uuid,
    vehicleId: uuid,
    serviceTypeId: uuid,
    technicianId: uuid,
    serviceBayId: uuid,
    startTime: dateTime,
    endTime: dateTime,
    status: { type: 'string', enum: ['CONFIRMED', 'CANCELLED'] },
    notes: { type: ['string', 'null'] },
    createdAt: dateTime,
    cancelledAt: { type: ['string', 'null'], format: 'date-time' },
  },
} as const;

export const createAppointmentBody = {
  type: 'object',
  additionalProperties: false,
  required: ['dealershipId', 'customerId', 'vehicleId', 'serviceTypeId', 'startTime'],
  properties: {
    dealershipId: uuid,
    customerId: uuid,
    vehicleId: uuid,
    serviceTypeId: uuid,
    startTime: { ...dateTime, description: 'ISO-8601 with offset, aligned to 15 minutes, e.g. 2026-11-03T09:00:00Z' },
    notes: { type: 'string', maxLength: 1000 },
  },
} as const;

export const idempotencyHeaders = {
  type: 'object',
  properties: {
    'idempotency-key': {
      type: 'string',
      minLength: 8,
      maxLength: 128,
      description: 'Optional. Retrying with the same key returns the original appointment instead of double-booking.',
    },
  },
} as const;

export const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: uuid },
} as const;

export const listAppointmentsQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    dealershipId: uuid,
    vehicleId: uuid,
    from: dateTime,
    to: dateTime,
    status: { type: 'string', enum: ['CONFIRMED', 'CANCELLED'] },
    limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
  },
} as const;

export const availabilityQuery = {
  type: 'object',
  additionalProperties: false,
  required: ['serviceTypeId', 'date'],
  properties: {
    serviceTypeId: uuid,
    date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Local date at the dealership (YYYY-MM-DD)' },
  },
} as const;

export const availabilityResponse = {
  type: 'object',
  properties: {
    dealershipId: uuid,
    serviceTypeId: uuid,
    date: { type: 'string' },
    slots: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          startTime: dateTime,
          endTime: dateTime,
          available: { type: 'boolean' },
          availableTechnicians: { type: 'integer' },
          availableBays: { type: 'integer' },
        },
      },
    },
  },
} as const;

export const dealership = {
  type: 'object',
  properties: {
    id: uuid,
    name: { type: 'string' },
    timezone: { type: 'string' },
    opensAt: { type: 'string' },
    closesAt: { type: 'string' },
  },
} as const;

export const serviceType = {
  type: 'object',
  properties: {
    id: uuid,
    code: { type: 'string' },
    name: { type: 'string' },
    durationMinutes: { type: 'integer' },
    requiredSkill: { type: 'string' },
  },
} as const;
