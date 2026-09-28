# Order Processing Microservices

[![CI](https://github.com/ebrahimmorkas/order-processing-microservices/actions/workflows/ci.yml/badge.svg)](https://github.com/ebrahimmorkas/order-processing-microservices/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![RabbitMQ](https://img.shields.io/badge/RabbitMQ-optional-FF6600?logo=rabbitmq&logoColor=white)
![MongoDB](https://img.shields.io/badge/MongoDB-database%20per%20service-47A248?logo=mongodb&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)

An event-driven e-commerce backend split into **five Node.js/TypeScript microservices**. It
demonstrates the patterns that make distributed systems correct, not just split up: a
**choreographed saga**, a **transactional outbox**, **idempotent consumers**, **compensating
actions**, **database-per-service**, and an **API gateway** that centralises authentication.

The event bus is pluggable. It uses **RabbitMQ** when available and falls back to a durable
**MongoDB-backed queue**, so the whole system runs with nothing but MongoDB. CI runs the full
suite, including an end-to-end saga test, on **both** transports.

## Architecture

```mermaid
flowchart LR
    Client -->|HTTPS + JWT| GW[API Gateway :8080]
    GW -->|x-user-id| AUTH[Auth :4001]
    GW --> ORD[Orders :4002]
    GW --> INV[Inventory :4003]
    GW --> NOT[Notifications :4004]

    AUTH --- AUTHDB[(ops_auth)]
    ORD --- ORDDB[(ops_orders)]
    INV --- INVDB[(ops_inventory)]
    NOT --- NOTDB[(ops_notifications)]

    AUTH -. user.registered .-> BUS{{Event bus<br/>RabbitMQ or MongoDB}}
    ORD <-. order.* / inventory.* .-> BUS
    INV <-. order.* / inventory.* .-> BUS
    BUS -. user.* / order.* .-> NOT
```

| Service           | Responsibility                                                                                           | Publishes                                                               | Consumes                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **gateway**       | Single entry point: JWT verification, routing, rate limiting, request-id propagation, health aggregation | —                                                                       | —                                                                         |
| **auth**          | Registration, login, JWT issuing                                                                         | `user.registered`                                                       | —                                                                         |
| **orders**        | Order lifecycle, saga state, transactional outbox                                                        | `order.created`, `order.confirmed`, `order.rejected`, `order.cancelled` | `inventory.reserved`, `inventory.rejected`                                |
| **inventory**     | Catalog, stock reservations, compensation                                                                | `inventory.reserved`, `inventory.rejected`, `inventory.released`        | `order.created`, `order.cancelled`                                        |
| **notifications** | In-app notifications and emails, local user read model                                                   | —                                                                       | `user.registered`, `order.confirmed`, `order.rejected`, `order.cancelled` |

### The order saga

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant G as Gateway
    participant O as Orders
    participant I as Inventory
    participant N as Notifications
    C->>G: POST /api/orders (JWT)
    G->>O: POST /orders (x-user-id, x-request-id)
    O->>O: save order PENDING + outbox[order.created] (one atomic write)
    O-->>C: 202 Accepted {status: PENDING}
    O--)I: order.created (outbox relay)
    alt stock available
        I->>I: hold stock per SKU (atomic, idempotent)
        I--)O: inventory.reserved {lines, total}
        O->>O: PENDING → CONFIRMED + outbox[order.confirmed]
        O--)N: order.confirmed
    else insufficient stock
        I->>I: release partial holds
        I--)O: inventory.rejected {reason}
        O->>O: PENDING → REJECTED + outbox[order.rejected]
        O--)N: order.rejected
    end
    N->>N: notification + email
    Note over O,I: Cancel → order.cancelled → inventory returns stock (compensation)
```

## Patterns and how they're implemented

| Pattern                          | Where                        | Details                                                                                                                                                                                                                                                                     |
| -------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Saga (choreography)**          | orders ↔ inventory           | No central orchestrator. Services react to each other's events. Rejections and cancellations trigger **compensating actions** (stock released).                                                                                                                             |
| **Transactional outbox**         | `services/orders`            | Events are appended to the order document in the _same atomic write_ as the state change, then published by an `OutboxRelay`. No lost events and no phantom events, without distributed transactions.                                                                       |
| **Idempotent consumer (inbox)**  | `@ops/common` `idempotent()` | Delivery is at-least-once, so processed event ids are recorded per service. Handlers also use conditional writes (`status: PENDING` guards), so duplicates and late replies are no-ops.                                                                                     |
| **Atomic reservations**          | `services/inventory`         | Each product stores its own holds, so _decrement stock + record the hold_ is one single-document update guarded by `stock >= qty` and "not already held by this order". There is no overselling, and a redelivered event resumes a crashed attempt without double-counting. |
| **Database per service**         | all                          | Each service owns its database, so the e2e test runs all five in one process with isolated DBs.                                                                                                                                                                             |
| **Local read model**             | `services/notifications`     | User contact details are projected from `user.registered`, so there's no synchronous call to auth.                                                                                                                                                                          |
| **API gateway**                  | `services/gateway`           | Auth happens at the edge. It forwards a trusted identity and strips spoofed `x-user-*` headers, returns `502` when an upstream is down, and aggregates `/health`.                                                                                                           |
| **Correlation ids**              | all                          | The client's `x-request-id` flows through the gateway into every event of the order, for tracing.                                                                                                                                                                           |
| **Retries + dead-letter queues** | event bus                    | Exponential backoff, then DLQ (RabbitMQ DLX, or a `dead` state in MongoDB).                                                                                                                                                                                                 |

## The event bus

```ts
interface EventBus {
  publish(event: DomainEvent): Promise<void>;
  subscribe(
    consumer: string,
    types: string[],
    handler: EventHandler,
    opts?: { maxAttempts },
  ): Promise<void>;
  deadLetterCount(consumer: string): Promise<number>;
  close(): Promise<void>;
}
```

|                               | `EVENT_BUS=rabbitmq`                             | `EVENT_BUS=mongo` (default)                                   |
| ----------------------------- | ------------------------------------------------ | ------------------------------------------------------------- |
| Routing                       | Durable topic exchange, routing key = event type | Subscription registry and per-consumer delivery documents     |
| Fan-out / competing consumers | Queue per consumer name                          | Delivery per consumer, claimed with atomic `findOneAndUpdate` |
| Durability                    | Persistent messages + publisher confirms         | Documents in MongoDB                                          |
| Crash recovery                | Unacked messages redelivered                     | Claim visibility timeout                                      |
| Retries                       | Re-queued with attempt header + backoff          | `availableAt` backoff                                         |
| Dead letters                  | `<consumer>.dlq` via DLX                         | `status: dead`                                                |

Both implementations pass the **same contract test suite**: fan-out, type filtering, competing
consumers without duplicates, retries and dead-lettering.

## Getting started

### Docker (recommended)

```bash
docker compose up --build                                        # event bus on MongoDB
EVENT_BUS=rabbitmq docker compose --profile rabbitmq up --build  # event bus on RabbitMQ (UI :15672)
```

Only the gateway is exposed: **http://localhost:8080**.

### Local Node.js

Requirements: Node.js 20+, MongoDB 6+ (RabbitMQ optional).

```bash
git clone https://github.com/ebrahimmorkas/order-processing-microservices.git
cd order-processing-microservices
cp .env.example .env
npm install
# one terminal per service:
npm run dev -w @ops/auth
npm run dev -w @ops/orders
npm run dev -w @ops/inventory
npm run dev -w @ops/notifications
npm run dev -w @ops/gateway
```

### Walkthrough

```bash
# Register (public) and keep the token
TOKEN=$(curl -s localhost:8080/api/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"me@example.com","name":"Me","password":"Password123"}' | jq -r .token)

# Browse the catalog (public)
curl -s localhost:8080/api/products | jq

# Place an order: 202 Accepted, status PENDING
ORDER=$(curl -s localhost:8080/api/orders -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: checkout-001' \
  -d '{"items":[{"sku":"KB-01","quantity":1},{"sku":"MS-02","quantity":2}]}' | jq -r .order.id)

# A moment later it is CONFIRMED (or REJECTED if stock ran out)
curl -s localhost:8080/api/orders/$ORDER -H "Authorization: Bearer $TOKEN" | jq .order.status

# Notifications produced by the saga
curl -s localhost:8080/api/notifications -H "Authorization: Bearer $TOKEN" | jq

# Cancel: stock is returned (compensation)
curl -s -X POST localhost:8080/api/orders/$ORDER/cancel -H "Authorization: Bearer $TOKEN" | jq
```

## API (through the gateway)

| Method | Path                                        | Auth   | Service              |
| ------ | ------------------------------------------- | ------ | -------------------- |
| POST   | `/api/auth/register`                        | public | auth                 |
| POST   | `/api/auth/login`                           | public | auth                 |
| GET    | `/api/auth/me`                              | JWT    | auth                 |
| GET    | `/api/products`, `/api/products/:sku`       | public | inventory            |
| POST   | `/api/orders` (`Idempotency-Key` supported) | JWT    | orders               |
| GET    | `/api/orders`, `/api/orders/:id`            | JWT    | orders               |
| POST   | `/api/orders/:id/cancel`                    | JWT    | orders               |
| GET    | `/api/notifications?unread=true`            | JWT    | notifications        |
| POST   | `/api/notifications/:id/read`               | JWT    | notifications        |
| GET    | `/health`                                   | public | gateway (aggregated) |

## Testing

```bash
npm test                                   # needs MongoDB (TEST_MONGO_URL)
EVENT_BUS=rabbitmq RABBITMQ_URL=amqp://guest:guest@localhost:5672 npm test
```

- **Contract tests** for both event-bus transports
- **Service tests** for each service, with collaborators simulated on the bus
- **End-to-end saga test** that boots all five services in-process (separate databases and bus
  connections) and drives them only through the gateway. It covers confirmation, rejection with
  rollback, cancellation with compensation, concurrent orders for the last units, correlation ids
  and aggregated health.

## Project structure

```
packages/common/          # @ops/common — shared toolkit, consumed as TypeScript source
  src/events/             # EventBus contract, RabbitMQ + MongoDB transports, inbox helper
  src/http.ts, auth.ts…   # Express bootstrap, errors, gateway identity, config, logging
services/
  gateway/                # routing, auth, rate limiting, health aggregation
  auth/ orders/ inventory/ notifications/
    src/service.ts        # service factory (app + start/stop), composable in tests
    src/main.ts           # process entry: config, DB, bus, HTTP server, graceful shutdown
test/e2e/                 # whole-system saga test
scripts/build.mjs         # esbuild: one bundle per service
Dockerfile                # one image definition, --build-arg SERVICE=...
```

## Trade-offs and next steps

- The outbox relay may publish an event twice after a crash. This is by design (at-least-once),
  and consumers deduplicate.
- The MongoDB bus trades throughput for zero extra infrastructure. RabbitMQ is the production
  choice.
- Next steps: a payment service as a third saga participant, OpenTelemetry tracing built on the
  existing correlation ids, and a Kubernetes deployment.

## License

[MIT](LICENSE)
