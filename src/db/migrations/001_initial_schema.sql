-- Unified Service Scheduler - initial schema
-- btree_gist lets us combine equality (=) on ids with range overlap (&&) in one
-- GiST exclusion constraint, which is what makes double-booking impossible at
-- the database level, even under concurrent requests.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE dealerships (
  id          UUID PRIMARY KEY,
  name        TEXT NOT NULL,
  timezone    TEXT NOT NULL,                 -- IANA zone, e.g. 'Europe/London'
  opens_at    TIME NOT NULL,                 -- local wall-clock time
  closes_at   TIME NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (opens_at < closes_at)
);

CREATE TABLE service_types (
  id                UUID PRIMARY KEY,
  code              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  duration_minutes  INTEGER NOT NULL CHECK (duration_minutes > 0 AND duration_minutes <= 720),
  required_skill    TEXT NOT NULL
);

CREATE TABLE technicians (
  id             UUID PRIMARY KEY,
  dealership_id  UUID NOT NULL REFERENCES dealerships(id),
  name           TEXT NOT NULL,
  skills         TEXT[] NOT NULL DEFAULT '{}',
  active         BOOLEAN NOT NULL DEFAULT true
);
CREATE INDEX technicians_dealership_idx ON technicians (dealership_id) WHERE active;
CREATE INDEX technicians_skills_idx ON technicians USING GIN (skills);

CREATE TABLE service_bays (
  id             UUID PRIMARY KEY,
  dealership_id  UUID NOT NULL REFERENCES dealerships(id),
  name           TEXT NOT NULL,
  active         BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (dealership_id, name)
);
CREATE INDEX service_bays_dealership_idx ON service_bays (dealership_id) WHERE active;

CREATE TABLE customers (
  id          UUID PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL UNIQUE,
  phone       TEXT
);

CREATE TABLE vehicles (
  id           UUID PRIMARY KEY,
  customer_id  UUID NOT NULL REFERENCES customers(id),
  vin          CHAR(17) NOT NULL UNIQUE,
  make         TEXT NOT NULL,
  model        TEXT NOT NULL,
  year         INTEGER NOT NULL
);

CREATE TYPE appointment_status AS ENUM ('CONFIRMED', 'CANCELLED');

CREATE TABLE appointments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dealership_id    UUID NOT NULL REFERENCES dealerships(id),
  customer_id      UUID NOT NULL REFERENCES customers(id),
  vehicle_id       UUID NOT NULL REFERENCES vehicles(id),
  service_type_id  UUID NOT NULL REFERENCES service_types(id),
  technician_id    UUID NOT NULL REFERENCES technicians(id),
  service_bay_id   UUID NOT NULL REFERENCES service_bays(id),
  start_time       TIMESTAMPTZ NOT NULL,
  end_time         TIMESTAMPTZ NOT NULL,
  status           appointment_status NOT NULL DEFAULT 'CONFIRMED',
  notes            TEXT,
  idempotency_key  TEXT UNIQUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at     TIMESTAMPTZ,
  CHECK (start_time < end_time),

  -- The core business invariants. Half-open ranges '[)' mean a booking that
  -- ends at 10:00 does not conflict with one that starts at 10:00.
  CONSTRAINT no_technician_double_booking EXCLUDE USING gist (
    technician_id WITH =,
    tstzrange(start_time, end_time, '[)') WITH &&
  ) WHERE (status = 'CONFIRMED'),

  CONSTRAINT no_bay_double_booking EXCLUDE USING gist (
    service_bay_id WITH =,
    tstzrange(start_time, end_time, '[)') WITH &&
  ) WHERE (status = 'CONFIRMED'),

  -- A single vehicle cannot physically be in two appointments at once.
  CONSTRAINT no_vehicle_double_booking EXCLUDE USING gist (
    vehicle_id WITH =,
    tstzrange(start_time, end_time, '[)') WITH &&
  ) WHERE (status = 'CONFIRMED')
);
CREATE INDEX appointments_dealership_time_idx ON appointments (dealership_id, start_time);
CREATE INDEX appointments_vehicle_idx ON appointments (vehicle_id);
