# Sratchpad: deployment and configuration

Sratchpad runs as **one container** on **AWS ECS (Fargate)**, with **Snowflake** as its only data
service (D-020 to D-026 in [`DECISIONS.md`](DECISIONS.md)). The container serves the Studio (`/`), the
viewer (`/view/`) and the API (`/bi-api/*`) on port 8080.

```
Route 53 ─► ALB (HTTPS, ACM cert) ─► ECS service "sratchpad" (2+ tasks, port 8080) ─► Snowflake
                                                       └─► Claude API (optional)
```

## 1. Snowflake (one time, as an admin)

Hybrid tables need a **non-trial** account; they are GA on AWS and Azure commercial regions.

```sql
CREATE ROLE BI_APP_ROLE;
CREATE WAREHOUSE BI_APP_WH WAREHOUSE_SIZE = XSMALL AUTO_SUSPEND = 300 AUTO_RESUME = TRUE;
CREATE DATABASE BI_APP;
CREATE SCHEMA BI_APP.APP;       -- hybrid tables: dashboards, versions, shares, upload records
CREATE SCHEMA BI_APP.UPLOADS;   -- one Snowflake-managed Iceberg table per upload
GRANT USAGE ON WAREHOUSE BI_APP_WH TO ROLE BI_APP_ROLE;
GRANT USAGE ON DATABASE BI_APP TO ROLE BI_APP_ROLE;
GRANT OWNERSHIP ON SCHEMA BI_APP.APP TO ROLE BI_APP_ROLE;
GRANT OWNERSHIP ON SCHEMA BI_APP.UPLOADS TO ROLE BI_APP_ROLE;

CREATE USER SRATCHPAD_SVC TYPE = SERVICE DEFAULT_ROLE = BI_APP_ROLE DEFAULT_WAREHOUSE = BI_APP_WH
  RSA_PUBLIC_KEY = '<public key>';          -- key-pair auth; the private key goes to Secrets Manager
GRANT ROLE BI_APP_ROLE TO USER SRATCHPAD_SVC;

-- For dashboards on teams' own tables: per-team roles and warehouses (SNOWFLAKE_TEAM_CONFIG),
-- each granted to SRATCHPAD_SVC and given SELECT on what that team may see.
-- Keep team roles SELECT-only and separate from BI_APP_ROLE: developers' custom SQL (spec 1.4) runs under
-- the team role and can read anything it can. Custom SQL is refused for a team without its own role, or whose
-- role is the app store or uploads role (D-071).
CREATE ROLE TEAM_A_READ;
GRANT USAGE ON WAREHOUSE TEAM_A_WH TO ROLE TEAM_A_READ;
GRANT USAGE ON DATABASE SALES TO ROLE TEAM_A_READ;
GRANT USAGE ON ALL SCHEMAS IN DATABASE SALES TO ROLE TEAM_A_READ;
GRANT SELECT ON ALL TABLES IN DATABASE SALES TO ROLE TEAM_A_READ;
GRANT SELECT ON ALL VIEWS IN DATABASE SALES TO ROLE TEAM_A_READ;
GRANT ROLE TEAM_A_READ TO USER SRATCHPAD_SVC;
```

The app creates and migrates its tables, stage and file format on boot and on first upload.

Cost: every app read runs on `BI_APP_WH`, so it must be running while people use the app. With
`AUTO_SUSPEND`, the first request after an idle period waits a few seconds for it to resume. Size it
(and enable multi-cluster) from the load test.

## 2. Secrets (AWS Secrets Manager)

| Secret | Env var | Value |
| --- | --- | --- |
| `sratchpad/bi-tokens` | `BI_TOKENS` | `token:team:subject[:role[:attributes]],…`: Studio/API access tokens (until SSO); attributes feed row-level security |
| `sratchpad/snowflake-private-key` | `SNOWFLAKE_PRIVATE_KEY` | PEM private key of `SRATCHPAD_SVC` |
| `sratchpad/anthropic-api-key` | `ANTHROPIC_API_KEY` | Optional: enables Claude ranking of suggestions and the Studio assistant |
| `sratchpad/metrics-token` | `BI_METRICS_TOKEN` | Optional: protects `/metrics` |
| `sratchpad/smtp-url` | `SMTP_URL` | Optional: SMTP credentials for subscription and alert emails (Amazon SES SMTP) |

Generate tokens with e.g. `openssl rand -base64 32`; give each person or app its own.

## 3. Image

```bash
docker build -t sratchpad .                          # from the repo root (bi-platform/)
docker build --platform linux/arm64 -t sratchpad .   # Graviton: set runtimePlatform ARM64 in the task def
aws ecr get-login-password | docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com
docker tag sratchpad <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/sratchpad:<TAG>
docker push <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/sratchpad:<TAG>
```

The image (`node:22-bookworm-slim`, about 420 MB) runs `node dist/server.mjs` as the non-root `node`
user with `NODE_ENV=production`, `PORT=8080`, JSON logs, and the built frontends in `/app/public`.

## 4. ECS

1. Fill the placeholders in [`deploy/ecs/task-definition.json`](../deploy/ecs/task-definition.json)
   (account, region, image tag, Snowflake account, hostname) and register it:
   `aws ecs register-task-definition --cli-input-json file://deploy/ecs/task-definition.json`.
2. IAM: the **execution role** needs `AmazonECSTaskExecutionRolePolicy` plus `secretsmanager:GetSecretValue`
   on the four secrets. The **task role** needs nothing (Snowflake and Claude are reached with secrets).
3. ALB: HTTPS listener (ACM certificate) → target group, type `ip`, HTTP port 8080, health check
   `GET /healthz`, healthy threshold 2. Idle timeout 120 s (uploads up to 50 MB). No stickiness needed.
4. Service: Fargate, 2+ tasks across AZs in private subnets with NAT (Snowflake and Claude are on the
   internet; use Snowflake PrivateLink if your policy requires it). Security group: ingress 8080 from the
   ALB only. Deployment circuit breaker on. Autoscale on CPU (e.g. 60 %).
5. DNS: point `sratchpad.<your domain>` at the ALB and put that host in `BI_PUBLIC_HOSTS`.

Shutdown is graceful on `SIGTERM` (`stopTimeout` 30 s). Logs go to CloudWatch `/ecs/sratchpad`.

## 5. First-deploy smoke test (do this on a non-trial Snowflake account)

The Snowflake paths are tested with fakes and adapters, not yet against a live account. After the first
deploy, as an editor:

1. Sign in to the Studio; the list loads (hybrid tables created; check `bi_schema_migrations`).
2. Upload a CSV; it appears as `BI_APP.UPLOADS.FILE_<ID>` (exercises `PUT` from the Node driver, the one
   step Snowflake's docs don't confirm) and its charts show data.
3. Build and save a dashboard; save again from a second tab to see the conflict prompt.
4. Share it as a viewer link (the link uses your hostname) and an app token; open the link in a private
   window; read the JSON with the token; revoke and confirm both stop working.
5. With `ANTHROPIC_API_KEY` set: open the Studio's Assistant tab and ask for a chart and a theme change;
   undo it; ask for something unsupported (a map) and check it says so.
6. Row-level security (if `BI_RLS_POLICIES` is set): a token with the attribute sees only its rows; a token
   without it gets `rls_denied`; a viewer link created by a restricted user is restricted too.
7. Email and webhooks (if `SMTP_URL` is set): create a subscription → **Send now** → the email arrives with a link
   and CSV; create an alert with a webhook to an endpoint you control → **Check now** → verify the signature.
8. Click a bar on a dashboard with click-to-filter on; drill down and back; switch tabs.
9. Check `/metrics` with the metrics token and the CloudWatch logs.

### Email (Amazon SES)

SES setup: verify the sender domain/address, leave the SES sandbox (or verify recipients), create SMTP credentials,
store `SMTP_URL` in Secrets Manager (`sratchpad/smtp-url`, already in the task definition). Outbound 465 from the
private subnets via NAT. Subscription links need `BI_PUBLIC_HOSTS` (or `BI_VIEWER_URL`).
Smoke test addition: create a subscription → **Send now** → email arrives with link + CSV; create an alert with a
webhook to a test endpoint you control → **Check now** → verify the signature.

## Before rolling out to every team

- **SSO**: an OIDC `TokenVerifier` (team and role from group claims) to replace access tokens.
- **Load test** (k6) against a production-shaped environment: size the warehouse and the task count.
- **Redis** (`REDIS_URL`, ElastiCache) once you run several tasks, so the result cache is shared.
- Decide whether viewer links should require a company login (open question in `DECISIONS.md`).

## Configuration reference

All configuration is environment variables (read in `services/api/src/config.ts` and
`src/data/snowflake/config.ts`). Production refuses unsafe combinations at startup.

### Server

| Var | Default | Meaning |
| --- | --- | --- |
| `NODE_ENV` | – | `production` requires `BI_TOKENS` and a durable store |
| `PORT` | `4000` (image: `8080`) | Listen port |
| `BI_STATIC_DIR` | – (image: `/app/public`) | Serve the built Studio and viewer from this process (single container) |
| `BI_PUBLIC_HOSTS` | – | Hostnames the app is served on; share links use the request host when listed |
| `BI_VIEWER_URL` | dev: `http://localhost:5176` | Explicit viewer URL for links (wins over `BI_PUBLIC_HOSTS`) |
| `BI_TOKENS` | dev tokens | `token:team:subject[:role[:attributes]]`, comma-separated; role `editor` (default) or `viewer`; attributes `region=EU\|US;country=FR`, `*` = all values |
| `BI_RLS_POLICIES` | – | Row-level security per team: `{"team-a": [{"field": "region", "attribute": "region", "source": {"type": "snowflake", "ref": "DB.S.ORDERS"}}]}`. Malformed = the server won't start |
| `BI_CORS_ORIGINS` | – | Origins allowed to call the API directly from browsers (not needed with one origin) |
| `BI_SEED` / `BI_SEED_TEAM` | memory: on / `team-a` | Load `examples/dashboards` into a team on boot |
| `BI_EXAMPLES_DIR` | repo `examples/dashboards` | Where the seed dashboards are |
| `BI_DATA_DIR` | `services/api/.data` (image: `/tmp/sratchpad`) | Local upload files (transient with Snowflake uploads) |
| `BI_QUERY_TIMEOUT_MS` | `15000` | Per-query timeout |
| `BI_CUSTOM_SQL` | `on` | `off` refuses custom SQL queries (spec 1.4) on every path. On Snowflake they also need a per-team role (below) |

### Storage

| Var | Default | Meaning |
| --- | --- | --- |
| `BI_STORE` | `postgres` if `DATABASE_URL`, else `memory` | `snowflake`, `postgres` or `memory` (dev only) |
| `DATABASE_URL` | – | Postgres connection (with `BI_STORE=postgres`) |
| `SNOWFLAKE_APP_DATABASE` / `_SCHEMA` | – / `PUBLIC` | Where the hybrid tables live |
| `SNOWFLAKE_APP_WAREHOUSE` / `_ROLE` | `SNOWFLAKE_WAREHOUSE` / `_ROLE` | Warehouse and role for the app's records |
| `SNOWFLAKE_APP_POOL_MAX` | `8` | Connections per task for the app store |
| `BI_UPLOADS` | `snowflake` with `BI_STORE=snowflake`, else `local` | Where uploaded data lives |
| `SNOWFLAKE_UPLOADS_DATABASE` / `_SCHEMA` | app database / `UPLOADS` | Where upload Iceberg tables live |
| `SNOWFLAKE_UPLOADS_WAREHOUSE` / `_ROLE` | app warehouse / role | Warehouse and role for loading and querying uploads |

### Snowflake connection and team tables

| Var | Default | Meaning |
| --- | --- | --- |
| `SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_USER` | – | Connection (all Snowflake features need these) |
| `SNOWFLAKE_PRIVATE_KEY` / `_PATH` or `SNOWFLAKE_PASSWORD` | – | Key-pair auth preferred |
| `SNOWFLAKE_WAREHOUSE`, `SNOWFLAKE_ROLE` | – | Defaults for teams' queries |
| `SNOWFLAKE_DATABASE` | – | Limits the source listing to one database |
| `SNOWFLAKE_TEAM_CONFIG` | – | Per-team overrides: `{"team-a": {"warehouse": "A_WH", "role": "A_ROLE", "database": "SALES"}}` |
| `SNOWFLAKE_STATEMENT_TIMEOUT_S` | `60` | Server-side statement timeout |
| `SNOWFLAKE_POOL_MAX` | `4` | Connections per team pool |
| `SNOWFLAKE_PROFILE_SAMPLE_ROWS` | `10000` | Rows the profiler samples |

### Cache, limits, observability, AI

| Var | Default | Meaning |
| --- | --- | --- |
| `BI_CACHE_TTL_S` | `60` | Result cache TTL; `0` off |
| `BI_CACHE_MAX_ENTRIES` | `2000` | In-process cache size |
| `REDIS_URL` | – | Shared cache across tasks (falls back to in-process if down at boot) |
| `BI_TEAM_MAX_CONCURRENT_QUERIES` / `_QUEUED_QUERIES` | `8` / `100` | Per-team query gate |
| `BI_RATE_LIMIT_DATA` / `_RECOMMENDATIONS` / `_UPLOADS` / `_WRITES` | `600` / `20` / `30` / `120` | Requests per minute per team; `0` off |
| `BI_LOG` / `BI_LOG_LEVEL` | `pretty` (prod `json`) / `info` | Log format and level |
| `BI_METRICS_TOKEN` | – | Bearer token for `/metrics` |
| `BI_AI` | `auto` | `auto` (on when Anthropic credentials exist), `on`, `off` |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` | – | Claude credentials |
| `BI_AI_MODEL` / `BI_AI_EFFORT` / `BI_AI_TIMEOUT_MS` | `claude-opus-5-5` / `low` / `20000` | Ranker settings |
| `BI_ASSISTANT` | `auto` | Studio chat assistant: `auto` (on with Anthropic credentials or a local Ollama), `on`, `off` |
| `BI_LLM_PROVIDER` | `anthropic` | `anthropic` (Claude) or `ollama` (**local testing only**; refused in production) |
| `OLLAMA_URL` / `OLLAMA_MODEL` / `OLLAMA_NUM_CTX` | `http://localhost:11434` / `llama3.2` / `16384` | Local model for ranking and the assistant when `BI_LLM_PROVIDER=ollama` |
| `BI_ASSISTANT_MODEL` / `BI_ASSISTANT_EFFORT` / `BI_ASSISTANT_TIMEOUT_MS` | `claude-opus-5-5` / `medium` / `90000` | Assistant settings |
| `BI_RATE_LIMIT_ASSISTANT` | `30` | Assistant turns per minute per team; `0` off |

### Platform (email, scheduler, webhooks)

| Var | Default | Meaning |
| --- | --- | --- |
| `SMTP_URL` | – | e.g. `smtps://<SES SMTP user>:<password>@email-smtp.<region>.amazonaws.com:465`. Unset: no email (runs recorded as not delivered). Secret. |
| `SMTP_FROM` | `Sratchpad <no-reply@sratchpad.invalid>` | Sender; must be a verified SES identity |
| `BI_SCHEDULER` | `on` | Run subscriptions/alerts/refresh in this process (lease ensures one task works) |
| `BI_SCHEDULER_INTERVAL_S` | `60` | Tick interval |
| `BI_WEBHOOK_ALLOWED_HOSTS` | – | Comma list of hosts or `.suffix` entries alerts may call; empty = any public host |
| `BI_WEBHOOK_TIMEOUT_MS` | `5000` | Webhook timeout |

### Frontend build and dev

| Var | Where | Meaning |
| --- | --- | --- |
| `VITE_BI_TOKEN` | Studio build | Bake a token in (dev only; production builds ask at sign-in) |
| `VITE_BI_API_URL` | Viewer build | API base if not `/bi-api` |
| `BI_API_URL` | Vite dev servers | Where `/bi-api` is proxied (default `http://localhost:4000`) |

## Local development

```bash
npm install
npm run dev        # API :4000 (memory store, seeded) · host apps :5173/:5174 · Studio :5175 · viewer :5176
npm test           # all suites; TEST_DATABASE_URL=postgres://… also runs the Postgres and Snowflake-adapter suites
npm run typecheck
```

AI features without an API key, on a local model (testing only):

```bash
ollama pull llama3.2                      # once
BI_LLM_PROVIDER=ollama npm run dev        # suggestions ranked and the Studio assistant run on Llama 3.2
OLLAMA_MODEL=llama3.1:8b BI_LLM_PROVIDER=ollama npm run dev   # a larger local model edits more reliably
```

With Llama 3.2 (3B) the assistant reliably adds simple charts; edits and styling are hit and miss (D-068).

Run the production server locally: `npm run build -w @yourorg/studio && npm run build -w @yourorg/viewer
&& npm run build -w @yourorg/bi-api`, copy `apps/studio/dist` and `apps/viewer/dist` into one folder as
`studio/` and `viewer/`, then start `node services/api/dist/server.mjs` with `NODE_ENV=production`,
`BI_STATIC_DIR`, `BI_TOKENS`, a durable store and `BI_PUBLIC_HOSTS=localhost:<port>`. Or just run the image.
