# dlms-server-pg

**DLMS Server – AWS Polyglot Edition**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Architecture: Polyglot](https://img.shields.io/badge/Architecture-AWS%20Polyglot-orange)](decisions/ADR-002-Polyglot-Architecture/README.md)

Document Lifecycle Management System server re-implemented on an AWS Polyglot stack that replaces MongoDB with **Amazon RDS PostgreSQL** (System of Record) + **Amazon OpenSearch Service** (Search Layer) + **Amazon S3** (Binary Storage & Backups).

The REST API surface is **100% backwards-compatible** with the original `dlms-server`.

---

## Architecture Overview

```
Client / Browser
      │  HTTPS
      ▼
┌─────────────────────┐
│  AWS ALB            │  (ECS Fargate – 2 tasks min in prod)
│  ┌───────────────┐  │
│  │  DLMS Server  │  │  Express + TypeScript
│  │  (Node.js)    │  │
│  └──┬────────┬───┘  │
└─────┼────────┼───────┘
      │        │
      │        │ async index / search
      ▼        ▼
  ┌───────┐  ┌─────────────┐   ┌──────────┐
  │  RDS  │  │ OpenSearch  │   │   S3     │
  │  PG16 │  │  Service    │   │ Buckets  │
  │ (SoR) │  │  (Search)   │   │ (Files + │
  └───────┘  └─────────────┘   │  Backups)│
                               └──────────┘
```

See [ADR-002](decisions/ADR-002-Polyglot-Architecture/README.md) for the full architectural decision record.

---

## Repository Structure

```
dlms-server-pg/
├── base/                   # Shared TypeScript types (dlms-base-pg)
│   └── src/index.ts        # DbAdapter, SearchAdapter, all DLMS interfaces
├── server/                 # Express REST API server
│   └── src/
│       ├── index.ts        # App entry point & Express wiring
│       ├── docMgr.ts       # Core business logic (database-agnostic)
│       ├── logger.ts
│       ├── mailer.ts
│       ├── db/
│       │   ├── pgAdapter.ts    # PostgreSQL implementation of DbAdapter
│       │   ├── osAdapter.ts    # OpenSearch implementation of SearchAdapter
│       │   └── s3Store.ts      # S3 binary attachment store
│       ├── middleware/
│       │   ├── auth.ts         # Basic Auth + OAuth OIDC + API Token
│       │   └── errorHandler.ts
│       └── controllers/
│           ├── docController.ts
│           ├── attachmentController.ts
│           ├── adminController.ts
│           ├── userGroupController.ts
│           └── actionController.ts
├── backup/                 # Backup / restore / reindex CLI
│   └── src/
│       ├── index.ts        # backup(), restore(), reindex(), listBackups()
│       └── cli.ts          # Commander.js CLI
├── infra/
│   └── terraform/
│       └── main.tf         # Full AWS infrastructure (VPC·RDS·OS·S3·ECS·ALB)
└── decisions/
    └── ADR-001-MongoDB-Migration
    └── ADR-002-Polyglot-Architecture
    
drwxr-xr-x@  4 dag  staff  128 Apr 19 12:56 ADR-002-Polyglot-Architecture
```

---

## Environment Variables

### PostgreSQL (System of Record)

| Variable | Description | Default |
|---|---|---|
| `DATABASE_URL` | Full PostgreSQL connection string | Built from PG_* vars |
| `PG_HOST` | PostgreSQL hostname | `localhost` |
| `PG_PORT` | PostgreSQL port | `5432` |
| `PG_DB` | Database name | `dlms` |
| `PG_USER` | Username | — |
| `PG_PASS` | Password (**secure this!**) | — |
| `PG_SSL` | Enable TLS (`true`/`false`) | `false` |
| `PG_POOL_MAX` | Max pool connections | `10` |

### OpenSearch (Search Layer)

| Variable | Description | Default |
|---|---|---|
| `OPENSEARCH_ENDPOINT` | Full OpenSearch URL | `http://localhost:9200` |
| `OPENSEARCH_USER` | HTTP auth username | — |
| `OPENSEARCH_PASS` | HTTP auth password | — |
| `OPENSEARCH_USE_AWS_AUTH` | Use SigV4 signing for AOSS | `false` |
| `OPENSEARCH_REPLICAS` | Index replica count | `1` |

### S3 (Binary Storage & Backups)

| Variable | Description | Default |
|---|---|---|
| `ATTACHMENTS_BUCKET` | S3 bucket for file attachments | `dlms-attachments` |
| `BACKUP_BUCKET` | S3 bucket for backups | `dlms-backups` |
| `BACKUP_PREFIX` | S3 key prefix for backups | `dlms-backups` |
| `S3_ENDPOINT` | Custom endpoint (LocalStack) | — |
| `AWS_REGION` | AWS region | `us-east-1` |

### Server (same as original dlms-server)

| Variable | Description | Default |
|---|---|---|
| `PORT` | HTTP port | `3000` |
| `BASE_URL` | Public base URL | `http://localhost:3000` |
| `IDS_ADMIN` | Comma-separated admin user IDs | — |
| `API_TOKEN` | Static API token for service accounts | — |
| `BASIC_AUTH_ENABLED` | Enable HTTP Basic Auth | `false` |
| `OAUTH_ENABLED` | Enable OIDC/OAuth | `false` |
| `OAUTH_ISSUER_URL` | OIDC issuer URL | — |
| `OAUTH_CLIENT_ID` | OAuth client ID | — |
| `OAUTH_CLIENT_SECRET` | OAuth client secret (**secure!**) | — |
| `SESSION_SECRET` | Session signing secret (**secure!**) | Random |
| `EMAIL_ENABLED` | Enable email notifications | `false` |
| `EMAIL_SERVER` | SMTP server URL | `localhost` |
| `CORS_ORIGIN` | CORS allowed origin | `*` |

---

## Quick Start (local development)

### Prerequisites
- Node.js 20+
- Docker & Docker Compose (for local PostgreSQL + OpenSearch)
- AWS credentials (for S3; or LocalStack for fully local dev)

### 1. Start local services

```bash
docker compose up -d   # see docker-compose.yml
```

### 2. Install and build

```bash
npm install
npm run build
```

### 3. Configure environment

```bash
cp .env.example .env
# Edit .env – minimum required:
# PG_HOST=localhost, PG_USER=dlms, PG_PASS=dlms, PG_DB=dlms
# OPENSEARCH_ENDPOINT=http://localhost:9200
# ATTACHMENTS_BUCKET=dlms-attachments   (or set S3_ENDPOINT for LocalStack)
```

### 4. Start the server

```bash
# Your application bootstraps DocMgr then calls start():
cd server && npm run dev
```

---

## New API Endpoints (beyond original dlms-server)

### Full-text Search

```
GET /api/docs/:type/search?q=<query>[&filters=<json>]
```

Routes to OpenSearch. Returns ranked results with `_score`.

```bash
curl "http://localhost:3000/api/docs/teamOutings/search?q=offsite+planning"
curl "http://localhost:3000/api/docs/teamOutings/search?q=approved&filters=%7B%22_state%22%3A%22approved%22%7D"
```

### Admin Health Check

```
GET /api/admin/health
```

Returns `{ pg: true, os: true }` — useful for ALB health checks and monitoring.

### Rebuild Search Index

```
POST /api/admin/reindex        (requires admin)
```

Re-populates OpenSearch from PostgreSQL. Use after OS domain replacement or bulk data operations.

---

## Backup & Restore

```bash
# Backup PostgreSQL to S3
npx dlms-backup backup --label pre-release-v2

# List available backups
npx dlms-backup list

# Restore from S3 key (also reindexes OpenSearch)
npx dlms-backup restore dlms-backups/pre-release-v2/2025-01-15T03-00-00-000Z.json.gz

# Dry-run to inspect backup contents
npx dlms-backup restore <key> --dry-run

# Rebuild OpenSearch only (PostgreSQL unchanged)
npx dlms-backup reindex
```

---

## Infrastructure (Terraform)

```bash
cd infra/terraform

# Initialise
terraform init

# Plan (review before applying)
terraform plan \
  -var="pg_username=dlms" \
  -var="pg_password=<secure>" \
  -var="container_image=<ecr-uri>"

# Apply
terraform apply
```

**Provisions:** VPC · 2 private + 2 public subnets · NAT Gateway · RDS PostgreSQL 16 Multi-AZ ·
OpenSearch 2.13 with VPC + encryption · S3 buckets (attachments + backups) with KMS SSE ·
ECS Fargate cluster + service + task definition · ALB · Auto Scaling · CloudWatch logging.

---

## Migration from MongoDB DLMS

1. Export data from the running MongoDB DLMS:
   ```bash
   curl -H "x-api-token: $TOKEN" http://old-server/api/admin/export > backup.json
   ```

2. Start the new Polyglot server and import:
   ```bash
   curl -X POST -H "Content-Type: application/json" \
        -H "x-api-token: $TOKEN" \
        --data @backup.json \
        http://new-server/api/admin/import
   ```

3. Verify search works:
   ```bash
   curl "http://new-server/api/docs/<type>/search?q=test"
   ```

---

## License

MIT — see [LICENSE](LICENSE)
