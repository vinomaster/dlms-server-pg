# ADR-001: Migration from MongoDB to AWS-Native Data Platform

## 1. Title

**Migration from MongoDB to AWS Managed Data Platform with Full-Text Search and Enterprise Backup/Restore**

## 2. Resources

* **ChatGPT Proposed**: Final - Enterprise Grade ADR
* **ChatGPT Executive Summary**: [Markdown](./ExecSummary/ADR-001-PG-ExecSummary.md) | [Word](./ExecSummary/ADR-001-PG-ExecSummary.docx) | [PDF](./ExecSummary/ADR-001-PG-ExecSummary.pdf)

## 3. Context

The organization currently operates MongoDB as its primary data store supporting transactional and semi-structured workloads.

Key enterprise requirements include:

- Full-text search
- Enterprise-grade backup and restore with an RDS-like experience
- Regulatory compliance support for frameworks such as SOC 2, HIPAA, GDPR, and PCI DSS
- High availability and scalability
- Reduced operational overhead
- AWS-native ecosystem alignment

## 4. Problem Statement

MongoDB provides flexibility and rapid development velocity, but at enterprise scale it can introduce governance, compliance, search, and operational maturity challenges.

## 5. Decision Drivers

The primary decision drivers are:

- Regulatory compliance and auditability
- Data consistency and governance
- Managed service maturity
- Full-text search capability
- Backup and restore robustness
- Migration complexity versus long-term sustainability

## 6. MongoDB Enterprise Drawbacks

### 6.1 Data Governance and Modeling

- Schema-less design can complicate governance and data standardization
- Data duplication is common when relational patterns are needed
- Referential integrity is not enforced in the same way as relational systems

### 6.2 Query and Operational Concerns

- Complex joins and reporting patterns are less natural
- Index tuning and sharding can increase operational overhead
- Cost predictability can be challenging as scale, storage, and indexing grow

### 6.3 Search Limitations

- Native MongoDB search options are typically less capable than dedicated search engines
- Advanced ranking, analyzers, and aggregations are stronger in OpenSearch-class platforms

## 7. Regulatory and Compliance Considerations

MongoDB is not inherently non-compliant, but it may introduce risks or barriers in regulated environments.

### 7.1 Governance Risk

- Flexible schema design can make consistent PII classification harder
- Validation discipline must be enforced at the application or platform layer

### 7.2 Auditability Risk

- Weak referential enforcement can make lineage and control tracing more difficult
- This can be a concern for financial controls and heavily governed systems

### 7.3 Licensing Considerations

- MongoDB licensing can raise legal or procurement concerns in some enterprises
- Organizations may prefer AWS-native services within an already approved cloud control boundary

### 7.4 Control Boundary Considerations

- Some regulated environments prefer tighter alignment with AWS-native IAM, KMS, backup, logging, and audit controls
- Native AWS services can simplify control mapping and evidence gathering

## 8. AWS Alternatives Considered

The main AWS-managed alternatives are:

- **Amazon DocumentDB** for MongoDB-compatible document workloads
- **Amazon RDS for PostgreSQL** for relational plus JSONB-supported workloads
- **Amazon DynamoDB** for key-value and high-scale access patterns
- **Amazon OpenSearch Service** for full-text search and search analytics

## 9. Architecture Options

### Option A: Migration Simplicity First

- Migrate MongoDB workloads to Amazon DocumentDB
- Add Amazon OpenSearch for search
- Optimize for lower initial migration friction

### Option B: Strategic Target State

- Migrate operational data to Amazon RDS for PostgreSQL
- Add Amazon OpenSearch for search
- Optimize for stronger governance, compliance, and long-term flexibility

## 10. Why Prefer RDS Over DocumentDB in the Target Polyglot Architecture

### 10.1 Why DocumentDB Is Attractive

DocumentDB has advantages when migration simplification is a major objective:

- Lower application rewrite effort
- Familiar document-centric model
- Faster initial transition path for MongoDB-oriented teams

### 10.2 Why RDS Is Preferred as the Long-Term System of Record

RDS for PostgreSQL is preferred in the long-term polyglot architecture because it offers:

- Stronger ACID behavior and transactional maturity
- Better auditability and governance controls
- Native relational constraints and joins
- Better reporting and analytics ecosystem support
- Mature backup, restore, and point-in-time recovery patterns
- JSONB support for semi-structured data where needed

### 10.3 Practical Decision Framing

A practical enterprise pattern is:

- Use **DocumentDB** only if migration speed and code preservation are the dominant near-term drivers
- Use **RDS PostgreSQL** as the long-term system of record if compliance, analytics, and control maturity matter more over time

## 11. Target Architecture Recommendation

Recommended target architecture:

- **System of record:** Amazon RDS for PostgreSQL
- **Search layer:** Amazon OpenSearch Service
- **Optional transitional bridge:** Amazon DocumentDB

This is a polyglot architecture because it separates transactional storage from dedicated search.

## 12. Full-Text Search Strategy

OpenSearch is recommended as the dedicated search layer because it provides:

- Advanced ranking and relevance controls
- Rich analyzers and tokenization options
- Aggregations and faceted search
- Independent scaling from the primary database

Tradeoffs include:

- A separate ingestion and synchronization pipeline is required
- Search results may be eventually consistent relative to the source of record
- Query patterns must be rewritten for OpenSearch

## 13. Full-Text Search Shortcomings When Migrating from MongoDB

When moving from MongoDB to AWS managed alternatives, search-related migration challenges can include:

- Search syntax changes between MongoDB search features and OpenSearch queries
- Relevance tuning must be revalidated
- Some application assumptions around embedded search may need redesign
- Index mappings and analyzers must be explicitly designed in OpenSearch

## 14. OpenSearch Ingestion Guide

### 14.1 Recommended Pattern

A recommended ingestion pattern is:

1. Land primary operational data in RDS PostgreSQL or DocumentDB
2. Capture changes using CDC, events, or scheduled synchronization
3. Transform records into search-friendly documents
4. Index those documents into OpenSearch
5. Monitor lag, indexing failures, and reindex requirements

### 14.2 Common AWS Components

Common AWS services used in the ingestion path include:

- AWS DMS for migration and CDC
- AWS Lambda for transformation logic
- Amazon Kinesis for streaming at scale
- Amazon S3 for landing, replay, or reindex staging
- Amazon OpenSearch Service for the search layer

### 14.3 Conceptual Flow

```text
Application
   ↓
RDS PostgreSQL or DocumentDB
   ↓
CDC / Events / DMS
   ↓
Lambda / Kinesis / Transformation
   ↓
OpenSearch Index
```

## 15. Migration Roadmap with Timelines

### Phase 0: Assessment (2 to 4 weeks)

- Inventory MongoDB clusters, databases, and collections
- Identify data models, query patterns, and search requirements
- Classify workloads by transactional, analytical, and search sensitivity

### Phase 1: Target Architecture and Design (2 to 3 weeks)

- Define the target data model in RDS and the search model in OpenSearch
- Decide whether DocumentDB will be used as a transition bridge
- Define backup, restore, IAM, KMS, and networking standards

### Phase 2: Foundation Setup (3 to 5 weeks)

- Deploy RDS PostgreSQL
- Deploy OpenSearch
- Configure logging, monitoring, security, backup, and restore policies
- Build CDC or ingestion pathways

### Phase 3: Initial Data Migration (4 to 8 weeks)

- Perform bulk migration from MongoDB
- Stand up synchronization for incremental changes
- Validate row counts, document completeness, and business-critical data paths

### Phase 4: Application Refactor (6 to 12 weeks)

- Rewrite data access logic where required
- Redesign search calls against OpenSearch
- Tune indexes, mappings, and performance paths

### Phase 5: Parallel Run and Validation (4 to 6 weeks)

- Run old and new platforms in parallel
- Compare outputs, search relevance, and operational metrics
- Resolve drift, latency, or functional gaps

### Phase 6: Cutover (1 to 2 weeks)

- Freeze changes as needed
- Perform final sync
- Shift application traffic to AWS target services
- Monitor closely during stabilization

### Phase 7: Decommission and Audit Closeout (2 to 4 weeks)

- Retire MongoDB workloads
- Archive required backups and artifacts
- Complete control evidence and post-migration review

## 16. Estimated Timeline Summary

Typical end-to-end timing:

- **Simplified migration using DocumentDB first:** about 2 to 4 months
- **Strategic migration to RDS plus OpenSearch:** about 4 to 8 months

## 17. Decision

The recommended decision is:

- Adopt **Amazon RDS for PostgreSQL plus Amazon OpenSearch Service** as the target architecture
- Use **Amazon DocumentDB** only as a transitional accelerator if reduced migration friction is critical

## 18. Consequences

### Positive Consequences

- Stronger governance and auditability
- Better alignment with enterprise control frameworks
- Strong backup and restore posture
- More capable search platform
- Better long-term reporting and analytics flexibility

### Negative Consequences

- Higher migration complexity than a simple DocumentDB move
- Search synchronization architecture must be maintained
- Application refactoring effort can be material

## 19. Final Recommendation

The recommended enterprise path is:

- **Near term:** consider DocumentDB only if migration simplification is the primary objective
- **Long term:** standardize on **RDS PostgreSQL as system of record** and **OpenSearch as search layer**

This balances short-term pragmatism with long-term enterprise quality.
