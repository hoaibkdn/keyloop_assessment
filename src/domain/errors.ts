/** Base class for errors that map cleanly onto an HTTP response. */
export abstract class DomainError extends Error {
  abstract readonly statusCode: number;
  abstract readonly code: string;
  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends DomainError {
  readonly statusCode = 422;
  readonly code = 'VALIDATION_FAILED';
}

export class NotFoundError extends DomainError {
  readonly statusCode = 404;
  readonly code = 'NOT_FOUND';
}

/** No technician + bay pair is free for the requested window. */
export class NoAvailabilityError extends DomainError {
  readonly statusCode = 409;
  readonly code = 'NO_AVAILABILITY';
}

/** The vehicle already has a confirmed appointment overlapping this window. */
export class VehicleAlreadyBookedError extends DomainError {
  readonly statusCode = 409;
  readonly code = 'VEHICLE_ALREADY_BOOKED';
}

/** The same Idempotency-Key was reused with a different request body. */
export class IdempotencyConflictError extends DomainError {
  readonly statusCode = 409;
  readonly code = 'IDEMPOTENCY_KEY_REUSED';
}

export class InvalidStateError extends DomainError {
  readonly statusCode = 409;
  readonly code = 'INVALID_STATE';
}
