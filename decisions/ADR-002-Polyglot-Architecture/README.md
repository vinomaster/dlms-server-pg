# ADR-002: Replace MongoDB with AWS Polyglot Architecture (RDS PostgreSQL + OpenSearch)

**Status:** Proposed  
**Date:** 2026-04-19  
**Deciders:** DLMS Core Team  
**Supersedes:** [MONGO Preference](https://github.com/discoverfinancial/dlms-server#setup-the-db)

---

## Context

The original DLMS architecture uses MongoDB as its single data store, chosen for schema flexibility
and rapid development velocity.  Enterprise adoption has been limited by four recurring concerns:

| Concern | Detail |
|---|---|
| **Compliance & regulatory ambiguity** | MongoDB's SSPL licence and proprietary Atlas control plane create legal uncertainty in regulated industries (financial services, healthcare, government). |
| **Data consistency & governance** | MongoDB's eventual-consistency default and lack of true ACID multi-document transactions make it harder to satisfy SOX, PCI-DSS, and data-lineage requirements. |
| **Operational & cost complexity** | Self-managed MongoDB clusters require specialist expertise; Atlas pricing scales non-linearly with data volume. |
| **Search & analytics limitations** | MongoDB Atlas Search is adequate for simple cases but lags purpose-built search engines in full-text relevance, faceting, and analytics at scale. |

## Decision

We adopt a **polyglot persistence** model that decouples concerns:

```
┌─────────────────────────────────────────────────────────────────┐
│                      DLMS Application Layer                     │
│   DocMgr  ─── DbAdapter interface ─── SearchAdapter interface  │
└──────────────────┬──────────────────────────┬───────────────────┘
                   │                          │
        ┌──────────▼──────────┐    ┌──────────▼──────────┐
        │  Amazon RDS         │    │  Amazon OpenSearch   │
        │  PostgreSQL 16      │    │  Service 2.x         │
        │  (System of Record) │    │  (Search Layer)      │
        └──────────┬──────────┘    └─────────────────────┘
                   │
        ┌──────────▼──────────┐
        │  Amazon S3          │
        │  (Binary Attachments│
        │   + Logical Backups)│
        └─────────────────────┘
```

### Component responsibilities

**Amazon RDS PostgreSQL 16** — System of Record  
- All document create/read/update/delete operations write to PostgreSQL first.
- JSONB columns preserve DLMS's schema-flexibility while enabling ACID transactions.
- Row-Level Security, column encryption (pgcrypto), and IAM database auth satisfy enterprise governance.
- Multi-AZ deployment with 30-day automated snapshot retention satisfies RPO/RTO requirements.
- Native PITR (point-in-time recovery) to any second within the retention window.

**Amazon OpenSearch Service 2.x** — Search Layer  
- Every write to PostgreSQL triggers an *asynchronous* index update in OpenSearch.
- PostgreSQL is authoritative; OpenSearch is a derived, eventually-consistent read replica.
- Provides full-text search, faceted filtering, fuzzy matching, and relevance scoring.
- Supports disaster-recovery reindex (`dlms-backup reindex`) from PostgreSQL at any time.
- VPC-deployed with encryption in transit and at rest, fine-grained access control.

**Amazon S3** — Binary & Backup Storage  
- File attachments are stored as S3 objects; only metadata (key, size, mime type) lives in PostgreSQL.
- Logical JSON backups produced by `dlms-backup backup` are gzip-compressed and uploaded to a
  versioned, lifecycle-managed S3 bucket.
- Server-side encryption with customer-managed KMS keys (SSE-KMS).

**Amazon ECS Fargate** — Compute  
- Stateless container execution; no EC2 fleet to patch.
- IAM task roles grant least-privilege access to RDS, OpenSearch, and S3 — no long-lived credentials.
- Auto-scales on CPU utilisation; minimum 2 tasks in production for HA.

## Consequences

### Positive
- ✅ PostgreSQL is open-source (PostgreSQL Licence) — no SSPL/commercial licence ambiguity.
- ✅ ACID transactions across all document operations satisfy SOX/PCI-DSS data-integrity requirements.
- ✅ AWS-native managed services reduce operational burden (patching, backups, HA all built-in).
- ✅ Full-text search quality meets or exceeds MongoDB Atlas Search for document workflow use cases.
- ✅ The `DbAdapter` / `SearchAdapter` interface pattern keeps DLMS itself database-agnostic —
  other backends (Aurora, ElasticSearch, local in-memory) can be swapped without changing DocMgr.
- ✅ Existing DLMS REST API surface is **100% backwards-compatible**; only environment variables change.
- ✅ New `/api/docs/:type/search` endpoint exposes OpenSearch full-text search to clients.
- ✅ New `/api/admin/reindex` endpoint supports operational recovery without downtime.

### Negative / Trade-offs
- ⚠️  OpenSearch writes are asynchronous — search results may lag writes by milliseconds to seconds.
- ⚠️  Two new AWS services (RDS + OpenSearch) increase infrastructure surface area vs. single MongoDB.
- ⚠️  JSONB queries are powerful but more verbose than MongoDB's query DSL for complex filters;
  complex queries should route through OpenSearch.
- ⚠️  Schema migrations require explicit DDL (`ALTER TABLE`) for new structured columns, though the
  `data JSONB` column continues to hold any ad-hoc fields without migration.

### Neutral
- 🔄  Migration from an existing MongoDB DLMS deployment uses the standard `/api/admin/export` +
  `/api/admin/import` path — no bespoke migration tooling required.

## Alternatives considered

| Alternative | Reason rejected |
|---|---|
| **Amazon DocumentDB** | MongoDB API-compatible but still AWS-proprietary; compliance concerns partially remain; no improvement in search capability. |
| **Aurora PostgreSQL + Aurora ML** | Would satisfy the DB concerns but does not provide purpose-built search. |
| **MongoDB Atlas on AWS** | Addresses operational burden but not the licence / compliance / search concerns. |
| **Single Aurora with full-text indexes** | `tsvector` full-text search is adequate for simple queries but lacks relevance tuning, faceting, and analytics that OpenSearch provides. |
