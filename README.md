# Keyloop Unified Service Scheduler (Scenario A, backend)

A REST API that books dealership service appointments **only when a qualified technician and a
service bay are both free for the whole service duration**, then saves a confirmed appointment
linking customer, vehicle, technician and bay.

- **Stack:** Node.js 22 · TypeScript · Fastify 5 · PostgreSQL 16 · Vitest
- **Design document:** [`docs/SYSTEM_DESIGN.md`](docs/SYSTEM_DESIGN.md) (architecture, data flow, technology choices, observability, assumptions)
- **Diagrams:** [`docs/ARCHITECTURE_DIAGRAMS.md`](docs/ARCHITECTURE_DIAGRAMS.md) (7 Mermaid diagrams, with PNG exports in `docs/diagrams/`)
- **API contract:** [`docs/openapi.json`](docs/openapi.json) · Swagger UI at `/docs` · [cURL examples](docs/api-examples.md)

## Highlights
- **No double-booking, including under concurrent requests.** A per-dealership advisory lock serialises the
  check-then-book step, and PostgreSQL `EXCLUDE USING gist` constraints make overlapping technician, bay or
  vehicle bookings impossible to store. A 12-way parallel race test verifies both.
- **Whole-duration checks.** Duration comes from the service type, and overlaps use half-open `[start, end)`
  ranges, so back-to-back bookings are allowed.
- **Skill-based, load-balanced assignment.** The system picks the least-booked technician with the required skill.
- **Timezone- and DST-aware opening hours** per dealership.
- **Idempotency-Key** support, so a client retry never creates a second booking (also verified under concurrency).
- **Observability:** structured JSON logs with request ids, Prometheus `/metrics`, and liveness/readiness probes.

## Quick start

Prerequisites: Node.js ≥ 22 and Docker.

```bash
npm install
cp .env.example .env            # optional; these are the defaults
npm run db:up                   # Postgres 16 on :5432 (also creates the scheduler_test DB)
npm run seed                    # runs migrations and loads demo dealerships, technicians, bays, vehicles
npm run dev                     # API on http://localhost:3000 (migrations also run on start)
```

Open <http://localhost:3000/docs> for Swagger UI, or follow [docs/api-examples.md](docs/api-examples.md).

**Run everything in containers:** `docker compose --profile full up --build` (then `npm run seed` from the host).

**Production build:** `npm run build && npm start`.

> **Note for Ubuntu users with snap-installed Docker:** snap Docker can't read files under `/media` or
> `/run/media` unless you run `sudo snap connect docker:removable-media`. Alternatively, start Postgres without Compose:
> ```bash
> docker run -d --name scheduler-pg -p 5432:5432 -e POSTGRES_USER=scheduler -e POSTGRES_PASSWORD=scheduler \
>   -e POSTGRES_DB=scheduler postgres:16-alpine
> docker exec scheduler-pg psql -U scheduler -c "CREATE DATABASE scheduler_test"
> ```

## Testing

```bash
npm test                 # all tests (needs Postgres running: npm run db:up)
npm run test:unit        # pure domain logic only, no database needed
npm run test:integration # HTTP + real PostgreSQL
npm run typecheck
```

Integration tests use `TEST_DATABASE_URL` (default `postgres://scheduler:scheduler@localhost:5432/scheduler_test`).
The schema in that database is dropped and recreated on each run.

| Suite | What it proves |
|---|---|
| `test/unit/scheduling.test.ts` (24) | Interval overlap (incl. back-to-back), opening hours in local time across BST/GMT, 15-minute alignment, past and horizon limits, slot generation, the DST 23-hour day, technician ranking, and the "needs both tech **and** bay" availability rule |
| `test/integration/appointments.test.ts` | Confirmed booking persisted with all associations; skill matching; dealership scoping; load balancing; tech-bound and bay-bound rejections; back-to-back allowed; vehicle double-booking blocked; 10 validation cases; idempotent replay and key misuse; cancellation frees resources |
| `test/integration/concurrency.test.ts` | **12 parallel requests for one slot with capacity 3 → exactly 3 bookings, 9 × 409, zero 5xx, zero overlaps in the DB.** Concurrent duplicate Idempotency-Keys → one row. DB constraints reject overlaps even when the app is bypassed |
| `test/integration/catalog.test.ts` | Availability grid reflects bookings in real time; catalog endpoints; readiness; metrics; request-id propagation; OpenAPI served |

## API summary
| Method | Path | Purpose |
|---|---|---|
| `POST` | `/appointments` | Book (auto-assigns technician and bay). Optional `Idempotency-Key` header. `201` / `200` replay / `409` / `422` |
| `GET` | `/appointments/{id}` | Fetch an appointment |
| `GET` | `/appointments?dealershipId&vehicleId&from&to&status&limit` | Schedule / history |
| `POST` | `/appointments/{id}/cancel` | Cancel and release resources |
| `GET` | `/dealerships/{id}/availability?serviceTypeId&date` | Real-time availability grid for a day |
| `GET` | `/dealerships`, `/service-types` | Catalog |
| `GET` | `/health/live`, `/health/ready`, `/metrics`, `/docs` | Ops |

Regenerate the static spec after changing routes: `npm run openapi`.

## Project layout
```
src/
  app.ts                  Fastify app factory: plugins, error mapping, request-id, ops endpoints
  server.ts               Entry point: config, migrations, graceful shutdown
  domain/                 Pure business rules (no I/O): scheduling.ts, errors.ts, types.ts
  services/               BookingService: transaction, lock, retry, idempotency
  repositories/           Parameterised SQL (reference data, resources, appointments)
  routes/                 HTTP routes and JSON Schemas (validation + OpenAPI)
  observability/          Prometheus metrics
  db/                     Pool, migration runner, SQL migrations, seed data
test/unit, test/integration
docs/                     System design, OpenAPI spec, cURL examples
```

## AI Collaboration Narrative

**Tooling.** I used Claude Code (an agentic coding CLI) as the main implementer. My role was to set
direction, make the decisions, and verify the work. The agent's role was to research, draft and execute.

**Strategy for guiding the AI**
1. **Context first.** The agent read and summarised the challenge PDF before any code was written, so we
   shared the same understanding of the acceptance criteria.
2. **Constraints up front.** I fixed the stack (Node) and the scenario (A, backend). Every assumption the
   brief left open (who picks the technician, back-to-back bookings, timezones, vehicle double-booking) went
   into the design document so it could be reviewed rather than left implicit in the code.
3. **Design for verifiability.** I asked for business rules as pure functions (unit-testable without a
   database) and for the core invariant to be enforced by the database itself, so correctness didn't depend
   on the AI writing perfect application code.
4. **Small, checkable steps.** Schema → domain → repositories → service → routes, with a typecheck after
   each layer and tests before docs.

**Verification and refinement (where the AI was wrong and how we caught it)**
- **A concurrency bug that a single test run would have missed.** The first booking design used optimistic
  inserts, letting the exclusion constraint reject losers and retrying. It looked correct, and the parallel
  race test passed. I had the suite **run repeatedly** instead of trusting one green run: 2 of the first 3
  runs failed, with only **1 of 3** possible bookings made and 500 errors returned. Postgres logs showed
  `deadlock detected` between concurrent exclusion-constraint checks. The fix was a per-dealership advisory
  lock around check-then-insert, plus treating `40P01` as retryable. I re-verified with **25 consecutive
  green runs**, and runtime fell from about 13s to about 3s. The test now also asserts *zero 5xx responses*,
  so this class of bug can't come back silently.
- **A wrong test, not wrong code.** A metrics test assumed a global counter started at zero. I diagnosed it
  as test-order coupling and rewrote it to assert the *change* in the counter rather than loosening the assertion.
- **Database-level proof.** I added tests that bypass the application and insert overlapping rows directly,
  proving the database guarantee holds even if the service layer is wrong.
- **No hallucinated dependencies.** Package versions were looked up in the npm registry, not recalled from
  memory. I deliberately chose TypeScript 5.9 over the brand-new 7.0, and kept `prom-client` after checking
  that its suggested successor is still pre-1.0.
- **Docs checked against reality.** Every response shown in `docs/api-examples.md` was replayed against the
  running server. The OpenAPI file is generated from the route schemas, not written by hand.
- **Environment problems handled openly.** Snap-packaged Docker couldn't read the project directory. Rather
  than changing system settings, I worked around it and documented both the fix and the workaround above.

**How I ensured final quality.** Strict TypeScript (`noUncheckedIndexedAccess`). 61 tests across unit,
integration, concurrency and DB-invariant levels, run against real Postgres rather than mocks. Repeated test
runs for anything timing-dependent. I read every generated file for correctness, naming and consistency
before committing.
