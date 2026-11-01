# Tenant Feature Flag Service

[![CI](https://github.com/yashybm30/feature-flag-service/actions/workflows/ci.yml/badge.svg)](https://github.com/yashybm30/feature-flag-service/actions/workflows/ci.yml)

An independently runnable portfolio project demonstrating global defaults, per-tenant overrides and an authoritative global kill switch.

## Implemented behavior

- Global defaults, per-tenant overrides and an authoritative global kill switch
- Separate platform-operator and tenant-admin permissions
- PostgreSQL transactions couple changes with audit records
- Versioned Redis evaluation cache with database fallback and tenant keys

## Architecture

```mermaid
flowchart LR
 Client --> JWT[JWT guard]
 JWT --> Evaluate
 Evaluate --> PG[PostgreSQL defaults and kill state]
 Evaluate --> Redis
 Operator --> Audit[Transactional audit]
```

## Requirements and setup

Node.js 24 and npm. Docker Engine with Compose v2 is needed for local databases/queues. Native browser scraping also requires Chromium. Exact dependencies and reproducible versions are in package.json/package-lock.json.

```bash
npm ci
npm run check
```

```bash
cp .env.example .env
# Edit the environment before starting; use random independent signing secrets.
docker compose --env-file .env up --build -d
```

Run one stack at a time because localhost development ports overlap. For native execution, run `npm run build`, start the documented dependencies, apply migrations where applicable, then `npm start`. Node reads `.env` for the start and SQL migration scripts; Vitest requires exported test environment variables. Bash examples use `NAME=value command`; PowerShell uses `$env:NAME='value'` before the command.

PostgreSQL migrations: `npm run db:migrate` after `npm run build`. `DATABASE_URL` selects the database; optional `PGSCHEMA` selects an isolated SQL schema. Migrations create and version the initial schema. Use a separate DDL-capable migration connection and a restricted runtime role in production. Compose uses development-only credentials and must not be exposed as production database configuration.

## Configuration

- `PORT`: HTTP port (default 3000).
- `JWT_SECRET`: at least 48 random characters; match the trusted issuer when using auth-service tokens.
- `JWT_ISSUER` / `JWT_AUDIENCE`: default `portfolio-auth` / `portfolio-api`.
- `CORS_ORIGIN`: comma-separated browser origins, deny cross-origin by default.
- `REDIS_URL`: local Redis connection where applicable.
- `DATABASE_URL`: PostgreSQL connection, with credentials injected outside source control.
- `PGSCHEMA`: SQL schema name, default `public`; validated as a bounded identifier.
- `PLATFORM_ADMIN_SUB`: JWT subject allowed to modify global flags and kills; absent means global writes are denied.

## Usage and contracts

| Method | Endpoint | Access |
|---|---|---|
| POST | `/v1/flags` `{key,enabled}` | Configured platform operator; upsert global default |
| GET | `/v1/flags?offset=0` | Authenticated, bounded list |
| GET | `/v1/flags/:key/evaluate` | Evaluate for JWT tenant |
| PUT / DELETE | `/v1/flags/:key/override` | Admin of JWT tenant |
| PUT | `/v1/flags/:key/kill` `{enabled}` | Configured platform operator |
| GET | `/v1/flags/:key/audit` | Tenant-scoped audit, admin |
| DELETE | `/v1/flags/:key` | Platform operator; preserves audit history |

Set `PLATFORM_ADMIN_SUB` to an operator's authenticated subject UUID. A tenant owner cannot change global defaults merely by registering an admin account. Kill state and version are read from PostgreSQL before using a cached evaluation, so cached tenant values cannot override an active kill switch. Old versioned cache entries expire after 15 seconds. Unknown flags return 404; clients should choose their own explicit default on API failure.

### Authentication and health

Authenticated HTTP examples use `Authorization: Bearer $ACCESS_TOKEN`. Obtain a correctly scoped token from your trusted issuer or the portfolio auth service using the same signing/issuer/audience settings. No production debug token endpoint is exposed. GET `/health/live` verifies the process; GET `/health/ready` checks the project's primary dependencies. `/docs` exposes route documentation; request examples here define the detailed contracts.

## Validation

```bash
npm run check
npm run test:integration  # requires actual local dependencies, where a suite exists
```

Unit tests never imply integration success. Integration suites use disposable namespaces and test signing keys; never point them at production. Tests import compiled application modules to preserve NestJS decorator metadata. See Actions for the current hosted status. External provider calls and cloud deployments are not part of local acceptance.

## Deployment and operations

The Dockerfile uses a separate build stage and a non-root runtime. Start dependencies and migrations before the application. Compose is a local development setup. For GCP/GKE or another cloud, publish a reviewed image, inject secrets using the platform secret manager, configure private dependency connectivity, health probes and resource limits, and verify graceful shutdown. No paid cloud resource is created by this repository.

## Security and trade-offs

Bearer identity is verified with an explicit JWT algorithm, issuer, audience and structured claims. Tenant IDs come from verified tokens, not headers. New services validate access-token expiry but do not introspect the authentication service for immediate token revocation; use short-lived tokens or add an introspection boundary where required. Limits and permission checks are documented per endpoint. Use TLS, workload credentials, restricted networks, backups, request quotas and least-privilege runtime roles before real deployment.

## Known limitations

No percentage rollouts, feature dependencies, or client SDK are implemented. Global deletion cascades tenant overrides and preserves audit records. Identity revocation follows access-token expiry, without auth-service introspection.

## Roadmap

Expand failure-mode coverage, validate external integrations in a staging account, add deployment-specific telemetry and retention policy, and review action/dependency updates regularly. Features described above are implemented; this roadmap is not a completion claim.

MIT licensed. See CONTRIBUTING.md and SECURITY.md.

### Standalone development identities

For a disposable local setup without a separate identity server, set the same random `JWT_SECRET` as the API and run `npm run token:dev -- <subject-uuid> <tenant-uuid> <admin-or-member>`. The CLI prints a 15-minute token; it is disabled when `NODE_ENV=production`. Keep it in your shell session, never commit it or paste it into issues. This is a local development utility, not a public login endpoint. Production must use a trusted identity issuer.
