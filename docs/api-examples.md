# API examples (cURL)

These examples stand in for the frontend. They use the seeded ids, assume the API is on `localhost:3000`, and
use a date of **2026-11-03**. Change the date to any day in the next 90 days (bookings must be in the future).
Interactive docs are at <http://localhost:3000/docs>.

```bash
API=http://localhost:3000
LONDON=11111111-1111-4111-8111-111111111111
OIL=22222222-2222-4222-8222-000000000001      # 60 min, GENERAL
BRAKES=22222222-2222-4222-8222-000000000002   # 120 min, BRAKES (only Alice)
JANE=55555555-5555-4555-8555-000000000001
JANE_GOLF=66666666-6666-4666-8666-000000000001
RAJ=55555555-5555-4555-8555-000000000002
RAJ_TESLA=66666666-6666-4666-8666-000000000002
DAY=2026-11-03
```

## Catalog
```bash
curl -s $API/dealerships | jq
curl -s $API/service-types | jq
```

## Real-time availability for a day
```bash
curl -s "$API/dealerships/$LONDON/availability?serviceTypeId=$BRAKES&date=$DAY" \
  | jq '.slots[] | select(.available) | .startTime' | head
```

## Book an appointment → 201
```bash
curl -s -i -X POST $API/appointments \
  -H 'content-type: application/json' \
  -H 'idempotency-key: demo-booking-0001' \
  -d "{\"dealershipId\":\"$LONDON\",\"customerId\":\"$JANE\",\"vehicleId\":\"$JANE_GOLF\",
       \"serviceTypeId\":\"$BRAKES\",\"startTime\":\"${DAY}T09:00:00Z\",\"notes\":\"Squeaky front brakes\"}"
```
Re-running the exact command returns **200** with the same appointment (idempotent replay).

## The only BRAKES technician is busy → 409
```bash
curl -s -X POST $API/appointments -H 'content-type: application/json' \
  -d "{\"dealershipId\":\"$LONDON\",\"customerId\":\"$RAJ\",\"vehicleId\":\"$RAJ_TESLA\",
       \"serviceTypeId\":\"$BRAKES\",\"startTime\":\"${DAY}T10:00:00Z\"}" | jq
# {"error":{"code":"NO_AVAILABILITY","details":{"freeQualifiedTechnicians":0,"freeBays":2,...}}}
```

## Outside opening hours → 422
```bash
curl -s -X POST $API/appointments -H 'content-type: application/json' \
  -d "{\"dealershipId\":\"$LONDON\",\"customerId\":\"$RAJ\",\"vehicleId\":\"$RAJ_TESLA\",
       \"serviceTypeId\":\"$OIL\",\"startTime\":\"${DAY}T17:30:00Z\"}" | jq .error.code
```

## Schedule, fetch, cancel
```bash
curl -s "$API/appointments?dealershipId=$LONDON&from=${DAY}T00:00:00Z&to=${DAY}T23:59:59Z" | jq
curl -s $API/appointments/<id> | jq
curl -s -X POST $API/appointments/<id>/cancel | jq .status   # "CANCELLED"
```

## Ops
```bash
curl -s $API/health/ready
curl -s $API/metrics | grep scheduler_
```

## Error format
Every error has the same shape:
```json
{ "error": { "code": "NO_AVAILABILITY", "message": "...", "details": { }, "requestId": "..." } }
```
| Status | Code | Meaning |
|---|---|---|
| 400 | `BAD_REQUEST` | Body or query failed schema validation (bad UUID, missing or unknown field, no TZ offset) |
| 404 | `NOT_FOUND` | Dealership, service type, vehicle, customer or appointment doesn't exist |
| 409 | `NO_AVAILABILITY` | No qualified technician and bay are both free for the full duration |
| 409 | `VEHICLE_ALREADY_BOOKED` | The vehicle already has an overlapping appointment |
| 409 | `IDEMPOTENCY_KEY_REUSED` | Same key sent with a different body |
| 409 | `INVALID_STATE` | e.g. cancelling an already-cancelled appointment |
| 422 | `VALIDATION_FAILED` | Business rule: past, beyond 90 days, outside hours, not 15-min aligned, vehicle not owned by customer |
