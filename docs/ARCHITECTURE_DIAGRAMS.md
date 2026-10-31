# Architecture Diagrams: Unified Service Scheduler

All diagrams are Mermaid (they render natively on GitHub). Sources are in [`diagrams/`](diagrams/), and each has a PNG
export next to it for slides and presentations. See [`SYSTEM_DESIGN.md`](SYSTEM_DESIGN.md) for the written design.

| # | Diagram | Answers |
|---|---|---|
| 1 | [System context](#1-system-context) | Who uses the scheduler and which systems it talks to |
| 2 | [Deployment view](#2-deployment-view) | Stateless API replicas behind a gateway |
| 3 | [Component view (inside the API)](#3-component-view-inside-the-api) | Layered design: HTTP → application service → pure domain rules and repositories → Postgres |
| 4 | [Data model](#4-data-model) | `EXCLUDE` constraints on `technician_id`, `service_bay_id` and `vehicle_id` (over `tstzrange(start_time, end_time)`, confirmed rows only) make double-booking impossible to store |
| 5 | [Booking flow: POST /appointments](#5-booking-flow-post-appointments) | Every check from request to confirmed record, with the HTTP status for each outcome |
| 6 | [Concurrency: two customers, one technician](#6-concurrency-two-customers-one-technician) | How the per-dealership advisory lock and the exclusion constraint together stop double-booking |
| 7 | [Appointment lifecycle](#7-appointment-lifecycle) | States an appointment request can end in |

## 1. System context

Who uses the scheduler and which systems it talks to. Dashed boxes are assumed or future integrations.

```mermaid
flowchart LR
    customer(["👤 Customer"])
    advisor(["👤 Service Advisor"])

    subgraph keyloop["Keyloop Unified Service Scheduler"]
        ui["Booking UI / Dealer Portal<br/><i>stubbed: OpenAPI + cURL</i>"]
        api["Scheduler API<br/><b>Node.js · Fastify</b><br/>books technician + bay"]
        db[("PostgreSQL 16<br/>appointments, resources")]
    end

    dms["Dealer Management System / CRM<br/><i>source of customers & vehicles</i>"]
    obs["Monitoring<br/>Prometheus · Grafana · Log store"]
    notify["Notification Service<br/><i>future: email / SMS</i>"]

    customer -->|"choose service & time"| ui
    advisor -->|"view schedule, cancel"| ui
    ui -->|"REST / JSON"| api
    api -->|"SQL (pg pool)"| db
    dms -.->|"master data sync (assumed)"| db
    api -.->|"/metrics, JSON logs"| obs
    api -.->|"AppointmentConfirmed event (future)"| notify

    classDef future stroke-dasharray: 5 5,fill:#f6f6f6,color:#555
    class dms,notify future
```

PNG: [`diagrams/01-system-context.png`](diagrams/01-system-context.png)

## 2. Deployment view

Stateless API replicas behind a gateway. Postgres is the single source of truth for locks and invariants.

```mermaid
flowchart TB
    client["Clients<br/>web UI · dealer portal · partner systems"]
    gw["API Gateway / Load Balancer<br/>TLS · AuthN · rate limiting"]

    subgraph cluster["Container platform (e.g. Kubernetes) · stateless, horizontally scaled"]
        direction LR
        api1["scheduler-api<br/>replica 1"]
        api2["scheduler-api<br/>replica 2"]
        apiN["scheduler-api<br/>replica N"]
    end

    subgraph data["Data tier"]
        direction LR
        pg[("PostgreSQL primary<br/>writes · advisory locks ·<br/>exclusion constraints")]
        replica[("Read replica<br/><i>future: availability reads</i>")]
        pg -.->|"streaming replication"| replica
    end

    subgraph obs["Observability"]
        direction LR
        prom["Prometheus"] --> graf["Grafana<br/>dashboards & alerts"]
        logs["Log aggregator<br/>Loki / ELK / CloudWatch"]
    end

    client -->|HTTPS| gw
    gw -->|"HTTP · probes /health/ready"| cluster
    cluster -->|"pg pool, max 10 conns / replica"| pg
    prom -.->|"scrape /metrics"| cluster
    cluster -.->|"JSON logs via stdout"| logs

    classDef future stroke-dasharray: 5 5,fill:#f6f6f6,color:#555
    class replica future
```

PNG: [`diagrams/02-deployment.png`](diagrams/02-deployment.png)

## 3. Component view (inside the API)

Layered design: HTTP → application service → pure domain rules and repositories → Postgres.

```mermaid
flowchart TB
    req(["HTTP request"])

    subgraph http["HTTP layer · src/app.ts, src/routes"]
        direction LR
        hooks["Hooks<br/>x-request-id · latency"]
        schema["JSON Schema (Ajv)<br/>validation + OpenAPI"]
        routes["Routes<br/>appointments · catalog"]
        errh["Error handler<br/>DomainError → HTTP status"]
        hooks --> schema --> routes
        routes -. "errors" .-> errh
    end

    subgraph svc["Application layer · src/services"]
        booking["BookingService<br/>transaction · advisory lock ·<br/>retry · idempotency"]
    end

    subgraph domain["Domain layer · src/domain (pure, no I/O)"]
        direction LR
        rules["scheduling.ts<br/>overlaps · opening hours & TZ ·<br/>slots · technician ranking"]
        errors["errors.ts<br/>typed domain errors"]
    end

    subgraph repos["Data access · src/repositories"]
        direction LR
        refrepo["ReferenceRepository"]
        resrepo["ResourceRepository"]
        apptrepo["AppointmentRepository"]
    end

    subgraph infra["Infrastructure · src/db, src/observability"]
        direction LR
        pool["pg Pool +<br/>withTransaction"]
        mig["Migration runner"]
        metrics["Prometheus registry<br/>→ /metrics"]
    end

    pgdb[("PostgreSQL")]

    req --> hooks
    routes --> booking
    booking --> domain
    booking --> repos
    repos --> pool
    pool --> pgdb
    mig --> pgdb
    booking -. "counters" .-> metrics
```

PNG: [`diagrams/03-components.png`](diagrams/03-components.png)

## 4. Data model

`EXCLUDE` constraints on `technician_id`, `service_bay_id` and `vehicle_id` (over `tstzrange(start_time, end_time)`, confirmed rows only) make double-booking impossible to store.

```mermaid
erDiagram
    DEALERSHIP ||--o{ TECHNICIAN : employs
    DEALERSHIP ||--o{ SERVICE_BAY : has
    CUSTOMER ||--o{ VEHICLE : owns
    DEALERSHIP ||--o{ APPOINTMENT : hosts
    CUSTOMER ||--o{ APPOINTMENT : books
    VEHICLE ||--o{ APPOINTMENT : "is serviced in"
    SERVICE_TYPE ||--o{ APPOINTMENT : "defines duration of"
    TECHNICIAN ||--o{ APPOINTMENT : "is assigned"
    SERVICE_BAY ||--o{ APPOINTMENT : "is occupied by"

    DEALERSHIP {
        uuid id PK
        text name
        text timezone "IANA, e.g. Europe/London"
        time opens_at "local time"
        time closes_at "local time"
    }
    SERVICE_TYPE {
        uuid id PK
        text code UK
        text name
        int duration_minutes
        text required_skill "e.g. BRAKES"
    }
    TECHNICIAN {
        uuid id PK
        uuid dealership_id FK
        text name
        text_array skills
        bool active
    }
    SERVICE_BAY {
        uuid id PK
        uuid dealership_id FK
        text name
        bool active
    }
    CUSTOMER {
        uuid id PK
        text name
        text email UK
        text phone
    }
    VEHICLE {
        uuid id PK
        uuid customer_id FK
        char17 vin UK
        text make
        text model
        int year
    }
    APPOINTMENT {
        uuid id PK
        uuid dealership_id FK
        uuid customer_id FK
        uuid vehicle_id FK
        uuid service_type_id FK
        uuid technician_id FK "EXCLUDE overlap"
        uuid service_bay_id FK "EXCLUDE overlap"
        timestamptz start_time
        timestamptz end_time
        enum status "CONFIRMED or CANCELLED"
        text idempotency_key UK
        timestamptz created_at
        timestamptz cancelled_at
    }
```

PNG: [`diagrams/04-data-model.png`](diagrams/04-data-model.png)

## 5. Booking flow: POST /appointments

Every check from request to confirmed record, with the HTTP status for each outcome.

```mermaid
sequenceDiagram
    autonumber
    actor C as Client
    participant R as Route + Ajv
    participant S as BookingService
    participant D as Domain rules
    participant DB as PostgreSQL

    C->>R: POST /appointments<br/>{dealershipId, customerId, vehicleId,<br/>serviceTypeId, startTime} + Idempotency-Key?
    R->>R: validate schema (UUIDs, date-time, no extra fields)
    alt invalid body
        R-->>C: 400 BAD_REQUEST
    end
    R->>S: book(request, key)
    S->>D: parseStartTime (offset required)

    opt Idempotency-Key present
        S->>DB: SELECT … WHERE idempotency_key = key
        alt key already used
            S-->>C: 200 original appointment<br/>(409 if body differs)
        end
    end

    par load reference data
        S->>DB: dealership
    and
        S->>DB: service type
    end
    S->>DB: vehicle, customer
    alt any not found
        S-->>C: 404 NOT_FOUND
    end
    S->>D: window = start + duration<br/>assertBookableWindow(future, ≤90d, 15-min, opening hours in local TZ)
    alt rule broken / vehicle not owned
        S-->>C: 422 VALIDATION_FAILED
    end

    S->>DB: BEGIN
    S->>DB: pg_advisory_xact_lock(hash(dealershipId))
    S->>DB: free qualified technicians in [start,end) + booked minutes today
    S->>DB: free bays in [start,end)
    alt no technician or no bay free
        S->>DB: ROLLBACK
        S-->>C: 409 NO_AVAILABILITY {freeQualifiedTechnicians, freeBays}
    else both available
        S->>D: rankTechnicians (least loaded) · rankBays
        S->>DB: INSERT appointment (exclusion constraints re-check)
        S->>DB: COMMIT (lock released)
        S-->>R: appointment
        R-->>C: 201 Created + Location
    end

    Note over S,DB: On 23P01 (overlap) or 40P01 (deadlock):<br/>re-read & retry, max 3 attempts, then 409
```

PNG: [`diagrams/05-booking-sequence.png`](diagrams/05-booking-sequence.png)

## 6. Concurrency: two customers, one technician

How the per-dealership advisory lock and the exclusion constraint together stop double-booking.

```mermaid
sequenceDiagram
    autonumber
    participant A as Request A<br/>(Jane, 09:00 brakes)
    participant B as Request B<br/>(Raj, 09:00 brakes)
    participant DB as PostgreSQL

    Note over A,B: Both arrive at the same instant for the same dealership.<br/>Only Alice has the BRAKES skill.

    A->>DB: BEGIN · pg_advisory_xact_lock(London)
    activate A
    B->>DB: BEGIN · pg_advisory_xact_lock(London)
    Note right of B: blocked: waits for A's lock

    A->>DB: free technicians → [Alice] · free bays → [Bay 1, 2, 3]
    A->>DB: INSERT (Alice, Bay 1, 09:00–11:00)
    A->>DB: COMMIT → lock released
    deactivate A
    Note over A: → 201 Created<br/>(Alice, Bay 1)

    activate B
    Note right of B: lock acquired, reads fresh committed state
    B->>DB: free technicians → [] · free bays → [Bay 2, 3]
    B->>DB: ROLLBACK
    deactivate B
    Note over B: → 409 NO_AVAILABILITY

    Note over A,DB: Safety net: even without the lock, the GiST EXCLUDE constraint<br/>(technician_id =, tstzrange &&) WHERE status='CONFIRMED'<br/>makes a second overlapping row for Alice impossible to commit.
```

PNG: [`diagrams/06-concurrency.png`](diagrams/06-concurrency.png)

## 7. Appointment lifecycle

States an appointment request can end in.

```mermaid
stateDiagram-v2
    direction LR
    [*] --> Requested: POST /appointments
    Requested --> Rejected: 400 / 404 / 422<br/>invalid or rule broken
    Requested --> Unavailable: 409<br/>no tech + bay pair free
    Requested --> CONFIRMED: 201<br/>tech + bay assigned
    CONFIRMED --> CANCELLED: POST /appointments/{id}/cancel<br/>resources released
    CANCELLED --> CANCELLED: cancel again → 409 INVALID_STATE
    Rejected --> [*]
    Unavailable --> [*]
    CANCELLED --> [*]
    CONFIRMED --> [*]: service completed<br/>(out of scope)

    note right of CONFIRMED
        Only CONFIRMED rows take part
        in the overlap constraints
    end note
```

PNG: [`diagrams/07-appointment-lifecycle.png`](diagrams/07-appointment-lifecycle.png)
