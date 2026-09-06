# Secure Notes Application

A full-stack note-taking application built with **Next.js 16 (App Router)**,
**Postgres** (via Drizzle ORM), **Valkey** (Redis-compatible cache), and a
full **Prometheus + Grafana** observability stack. It features Argon2 password
hashing, TOTP two-factor authentication, Valkey-backed rate limiting and 2FA
challenges, and database-transaction-safe note editing with version snapshots.

---

## Table of Contents

1. [Stack](#stack)
2. [Prerequisites](#prerequisites)
3. [Local Docker Compose Setup](#local-docker-compose-setup)
4. [Running the App](#running-the-app)
5. [Database Migrations](#database-migrations)
6. [Environment Variables](#environment-variables)
7. [Observability Pipeline](#observability-pipeline)
8. [Golden Signals](#golden-signals)
9. [Load Testing with Locust](#load-testing-with-locust)
10. [Monitoring Traffic Spikes in Grafana](#monitoring-traffic-spikes-in-grafana)
11. [Testing](#testing)

---

## Stack

| Component  | Technology                                     | Container        | Host port |
| ---------- | ---------------------------------------------- | ---------------- | --------- |
| Web app    | Next.js 16 + React 19 + Drizzle ORM            | `secure-notes-web` | 3000      |
| Database   | PostgreSQL 16.4-alpine                         | `secure-notes-postgres` | 5432 |
| Cache      | Valkey 7.2.5-alpine (Redis-compatible)         | `secure-notes-valkey`  | 6379 |
| Metrics    | Prometheus (`prom/prometheus:v2.54.0`)          | `secure-notes-prometheus` | 9090 |
| Dashboards | Grafana 10.4.2                                 | `secure-notes-grafana` | 3100 |

---

## Prerequisites

- **Docker Desktop** (with `docker compose` v2) — runs all services including the web app.
- **Node.js 22+** — for running unit/e2e tests and tooling on the host.
- **Python 3.10+** — for the Locust load test.
- `curl.exe` (or your HTTP tool of choice) for hitting the metrics endpoint.

---

## Local Docker Compose Setup

All services are defined in `docker-compose.yml`, which builds the Next.js
app from the included `Dockerfile` and wires up Postgres, Valkey, Prometheus,
and Grafana into one network.

```bash
# 1. Create .env from the template (optional but recommended)
cp .env.example .env

# 2. Generate a metrics scrape token (used to secure /api/metrics)
#    Add it to .env as: METRICS_TOKEN=<long-random-string>
python -c "import secrets; print(secrets.token_urlsafe(40))"

# 3. Build and start the entire stack
docker compose up -d --build

# 4. Verify everything is healthy
docker compose ps
```

Expected health:

```
NAME                      STATUS
secure-notes-grafana      Up (healthy)
secure-notes-postgres     Up (healthy)
secure-notes-valkey       Up (healthy)
secure-notes-prometheus   Up
secure-notes-web          Up
```

The `web` container runs `next dev` and bind-mounts the repo into
`/app` (with an anonymous `node_modules` volume) so edits hot-reload without
rebuilding the image.

### Ports

| URL                      | What it is                                  |
| ------------------------ | ------------------------------------------- |
| http://localhost:3000    | Next.js application                          |
| http://localhost:9090    | Prometheus UI                                |
| http://localhost:3100    | Grafana (`admin` / `admin`)                  |
| localhost:5432           | PostgreSQL                                   |
| localhost:6379           | Valkey                                       |

> **Grafana dashboards are auto-provisioned.** The `grafana/provisioning/`
> directory contains the Prometheus datasource and the **Secure Notes
> Telemetry** dashboard; both load automatically on container start.

---

## Running the App

```bash
# All services (recommended)
docker compose up -d

# Web-only dev server (expects Postgres + Valkey already running)
npm install
npm run dev
```

Open http://localhost:3000, register an account, and start taking notes.

---

## Database Migrations

Schema changes are applied with Drizzle's push workflow ([`drizzle.config.ts`](./drizzle.config.ts)):

```bash
npx drizzle-kit push
```

The command connects to the Postgres container using `DATABASE_URL` from
`.env` and reports `No changes detected` when the schema is in sync.

---

## Environment Variables

Runtime configuration lives in a root `.env` file. The web container loads it
via `env_file`; the host tools (Drizzle, Playwright, tests) read it too.

| Variable                      | Required | Description                                                       |
| ----------------------------- | -------- | ----------------------------------------------------------------- |
| `DATABASE_URL`                | Yes      | Postgres connection string (host `localhost` on host / `postgres` in Compose). |
| `VALKEY_URL`                  | Yes      | Valkey/Redis connection string (`redis://valkey:6379` in Compose).|
| `METRICS_TOKEN`               | Yes      | Bearer token required to `GET /api/metrics`. Must match the value used by Prometheus. |
| `TWO_FACTOR_ENCRYPTION_KEY`   | Yes*     | Key used to encrypt stored 2FA secrets (alphanumeric, 32-char). *Required to operate any 2FA flow.* |
| `E2E_BASE_URL`                | No       | Override the base URL Playwright uses (default `http://localhost:3000`). |

> **Security note:** `METRICS_TOKEN` is injected into the `web` container as
> an env var and written by the `prometheus` service entrypoint into
> `/etc/prometheus/metrics_token`, which is referenced by `prometheus.yml`
> via `bearer_token_file`. Never commit `.env` — it is gitignored.

---

## Observability Pipeline

```
Next.js app (prom-client)
   │  counters / histograms / gauges
   ▼
@prometheus-io/client Registry (single shared instance)
   │  (globalThis-backed so it survives dev hot-reload and dual-bundle)
   ▼
GET /api/metrics  (Bearer-token protected)
   │  text/plain; version=0.0.4
   ▼
Prometheus  (scrapes web:3000 every 15s, bearer_token_file)
   │
   ▼
Grafana  ("Secure Notes Telemetry" dashboard, auto-provisioned)
```

### How metrics reach Prometheus

1. **`src/lib/metrics.ts`** initializes the client and registers every metric
   on a **single global registry** (`globalThis.__secureNotesRegistry`). The
   route handler and the instrumented services all reference this same
   instance — this is what makes the counters observable in a dev
   environment with Turbopack's separate module graphs.
2. **`src/app/api/metrics/route.ts`** returns `registry.metrics()` as
   Prometheus text, gated behind `Authorization: Bearer <METRICS_TOKEN>`
   (constant-time compare). Unauthorized / missing-token requests get `401`.
3. **`prometheus.yml`** scrapes `http://web:3000/api/metrics` every 15s using
   the token file, so the endpoint is never exposed without credentials and
   there is no Postgres-facing scrape DoS vector.

### The scrape target

```
scrape_configs:
  - job_name: "web"
    metrics_path: /api/metrics
    bearer_token_file: /etc/prometheus/metrics_token
    static_configs:
      - targets: ["web:3000"]
```

Verify Prometheus is scraping the secured endpoint:

```bash
curl -s http://localhost:9090/api/v1/targets | grep -o '"health":"[a-z]*"'
# → "health":"up"
```

---

## Golden Signals

The "Secure Notes Telemetry" dashboard (folder **Secure Notes**) is built
around the four golden signals plus business/database telemetry.

| Signal      | Metric(s)                                                          | Grafana panel                |
| ----------- | ------------------------------------------------------------------ | --------------------------- |
| **Latency** | `http_request_duration_seconds` (histogram, `p95`)                 | "Request latency p95"        |
|            | `db_query_duration_seconds` (histogram, `p95` by statement)        | "DB query latency p95"       |
| **Traffic** | `http_requests_total{method,route,status_class}`                   | "HTTP requests /s"           |
|            | `db_queries_total{statement,status}`                               | "DB queries /s"              |
| **Errors**  | `http_errors_total{method,route,status_class}` (4xx/5xx)           | "HTTP error rate", "HTTP errors by status class" |
| **Saturation** | `db_active_connections` (from `pg_stat_activity`)               | "DB active connections"      |
|            | `db_queries_in_flight{statement}`                                  | "DB queries in flight"       |

Additional business telemetry (also scraped and paneled):

| Metric                    | Labels                                            | Meaning                              |
| ------------------------- | ------------------------------------------------- | ------------------------------------ |
| `auth_events_total`       | `type` (login/2fa), `status`, `reason`            | Auth + 2FA attempts and failures      |
| `note_operations_total`   | `operation` (create/update/autosave/delete/…)     | Note lifecycle churn                  |
| `cache_operations_total`  | `result` (hit/miss)                               | Valkey session-cache efficiency       |

All panels filter by `job="web"`.

---

## Load Testing with Locust

The repo ships a Locust workload at [`scripts/locustfile.py`](./scripts/locustfile.py)
that drives **real Next.js server actions** — not synthetic HTML — against the
running stack.

### Install

```bash
pip install locust
```

### What the script does

- **`SecureNotesUser`** (weight 4): a realistic journey — registers an
  account, logs out, logs back in (exercise password verification), then
  creates notes and performs autosave + manual-save edits (which insert
  version snapshots in DB transactions).
- **`RateLimitProbeUser`** (weight 1): deliberately hammers `/register` and
  `/login` to force **Valkey rate-limiter rejections** (surfaced as
  `rate limited (expected)` in the report) and churns note updates to stress
  the Postgres connection pool.
- Every user waits `between(1, 5)` seconds between actions to simulate
  realistic human pacing.

### Action IDs

Next.js server actions are invoked with a `Next-Action` header whose id is
regenerated on every dev-server restart. The script **discovers the ids at
runtime** from `server-reference-manifest.json` (the `.:/app` bind mount puts
it inside the repo). On failure it warns and falls back to constants matching
the current build.

### Run

Hosted UI (recommended for interactivity):

```bash
locust -f scripts/locustfile.py --host http://localhost:3000
# open http://localhost:8089
```

Headless (CI / quick soak):

```bash
locust -f scripts/locustfile.py --host http://localhost:3000 \
  --headless -u 20 -r 2 --run-time 5m --only-summary
```

Interpretation flags

- `-u` total simulated users, `-r` spawn rate (users/sec), `--run-time` duration.
- Requests marked `rate limited (expected)` are the probe class deliberately
  tripping the login/register/2FA limiters.

**Reset rate-limiter state between runs** (buckets are keyed by client IP):

```bash
docker compose exec valkey sh -c "redis-cli --scan --pattern 'ratelimit:*' | xargs -r redis-cli del"
```

---

## Monitoring Traffic Spikes in Grafana

1. Open **http://localhost:3100** and log in (`admin` / `admin`).
2. Navigate to **Dashboards → Secure Notes → Secure Notes Telemetry** (or open
   the search and pick it).
3. While the Locust run is active:

   - **HTTP requests /s** and **Request latency p95** (panels under *HTTP /
     API*) spike with the concurrent user count; latency climbs as the pool
     saturates.
   - **HTTP error rate / HTTP errors by status class** show the `4xx`/`5xx`
     set — expect `3xx` redirect traffic from the middleware and, while the
     probe class runs, the rate-limit rejections surfacing as action errors.
   - Under *Business events*, **auth /s**, **auth failures by reason**,
     **note operations /s**, and **cache operations /s** show the churn your
     virtual users generate.
   - Under *PostgreSQL*, **DB query latency p95**, **DB queries /s**,
     **DB active connections**, and **DB queries in flight** are the key
     saturation signals — if you raise `-u` you should see connections climb
     toward the pool max (`max: 10` in `src/db/index.ts`) and p95 latency
     rise.

4. Use the dashboard time-range picker (e.g. *Last 15 minutes*) or set the
   auto-refresh to `10s` to watch the spikes live.

You can also query the raw metrics with the token:

```bash
# Without a token
curl -i http://localhost:3000/api/metrics            # 401

# With a token
TOKEN=$(grep '^METRICS_TOKEN=' .env | cut -d= -f2)
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/metrics
```

---

## Testing

```bash
# Unit + integration tests (Vitest)
npm test

# End-to-end browser tests (Playwright) — requires the stack on :3000
npm run test:e2e

# Lint + typecheck
npm run lint
npx tsc --noEmit
```