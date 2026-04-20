# CycloneDX Use Case - Migration Strategy for NoSQL JSON 

## Prompt
We are interested in avoiding any regression in the search experience when migrating from a NoSQL platform like MongoDB. Given a NoSQL use case involving multi-object JSON documents where flattening the documents into a relational database structure must be avoided, what are the pros and cons for a AWS DocumentDB v. AWS Polyglot (RDS Postgres + OpenSearch) architecture. To form this comparison, let's use a grounded use-case based on the CycloneDX v1.6 JSON format. For this use case, besides the backup/restore retention requirements, we seek the ability to do $match and aggregate searches that optionally return cursors and can stream results. Lastly, the programmatic simplicity of parsing such NoSQL data using a TypeScript syntax such as `data.metadata.component.name` is a benchmark for developer usability.

## 1. Objective

Evaluate architecture options for migrating from a NoSQL platform (e.g., MongoDB) while:

- Preserving **multi-object JSON documents** (no flattening)
- Avoiding **regression in search experience**
- Supporting:
  - `$match` and aggregation-style queries
  - Cursor-based and streaming result sets
- Maintaining **developer usability**, e.g.:

```ts
data.metadata.component.name
```

## 2. Grounded Use Case: CycloneDX v1.6 JSON

CycloneDX SBOMs are deeply nested JSON documents with arrays and relationships.

### Example Structure

```json
{
  "bomFormat": "CycloneDX",
  "specVersion": "1.6",
  "metadata": {
    "component": {
      "name": "Acme Storefront Server",
      "version": "3.7.0"
    }
  },
  "components": [
    {
      "bom-ref": "pkg:npm/lodash@4.17.21",
      "type": "library",
      "name": "lodash",
      "version": "4.17.21"
    }
  ],
  "dependencies": [
    {
      "ref": "pkg:app/acme-storefront@3.7.0",
      "dependsOn": ["pkg:npm/lodash@4.17.21"]
    }
  ]
}
```

### Key Characteristics

- Deep nesting (`metadata.component.name`)
- Arrays (`components[]`, `dependencies[]`)
- Graph-like relationships
- Search across multiple dimensions (name, version, dependency, vulnerability)


## 3. Architecture Options


### Option A — AWS DocumentDB

#### Overview

A MongoDB-compatible document database that stores JSON natively and supports aggregation pipelines.


#### Strengths

1. Native Document Model

	- Stores CycloneDX JSON **without transformation**
	- No schema translation required


2. Mongo-Compatible Query Semantics Features

	- `$match`
	- `$group`
	- `$project`
	- Aggregation pipelines

	Example:

	```js
	db.boms.aggregate([
	  { $match: { "metadata.component.name": "Acme Storefront Server" } }
	])
	```

3. Developer Usability

	Direct mapping to application objects:
	
	```ts
	data.metadata.component.name
	```
	
	- No impedance mismatch
	- Minimal migration friction


4. Cursor-Based Retrieval

	- Native Mongo-style cursors
	- Batch retrieval and streaming patterns


5. Simpler Architecture

	- Single system for:
	  - Storage
	  - Query
	  - Aggregation


#### Limitations

1. Search Capability Risk

	- Not a purpose-built search engine
	- Limited:
	  - Full-text search
	  - Ranking/relevance tuning
	  - Faceting and advanced filtering UX

2. Mongo Compatibility Gaps

	- Not full MongoDB parity
	- Differences in:
	  - Query behavior
	  - Sorting guarantees
	  - Some operators

3. Search Experience Regression Risk

	- If current system relies on rich search UX, risk increases


#### Summary

* Pros

	- Closest to MongoDB
	- Zero JSON transformation
	- Strong developer ergonomics
	- Native aggregation support
	- Simpler architecture

* Cons

	- Weaker search capabilities
	- Compatibility gaps vs MongoDB
	- Potential search UX regression


### Option B — Polyglot Architecture  
>RDS PostgreSQL (JSONB) + OpenSearch

#### Overview

- **PostgreSQL (JSONB)** → system of record  
- **OpenSearch** → search engine  

#### Strengths

1. JSON Preservation via PostgreSQL JSONB

	- Store full CycloneDX document intact
	- Query using JSON operators / JSONPath

	Example:
	
	```sql
	SELECT data->'metadata'->'component'->>'name'
	FROM boms
	WHERE data->'metadata'->'component'->>'name' = 'Acme Storefront Server';
	```

2. Best-in-Class Search (OpenSearch) Features:
	
	- Full-text search
	- Faceting and filtering
	- Relevance ranking
	- Multi-field queries
	- Deep pagination:
	  - `scroll`
	  - `search_after`
	  - Point-in-time (PIT)


3. Strong Streaming & Pagination

	- Purpose-built for large result sets
	- Efficient cursor-like patterns

4. Backup & Retention (PostgreSQL)

	- Automated backups
	- Snapshots
	- Point-in-time restore (PITR)


5. Separation of Concerns

	| Layer | Responsibility |
	|------|--------------|
	| PostgreSQL | Source of truth |
	| OpenSearch | Search and retrieval |


#### Limitations

1. Architectural Complexity

	- Two systems instead of one
	- Requires:
	  - Data sync pipeline
	  - Monitoring
	  - Failure handling


2. Data Synchronization

	- Eventual consistency risk
	- Index lag possible

3. Developer Complexity

	- PostgreSQL → SQL + JSON operators
	- OpenSearch → Query DSL

	Less intuitive than Mongo-style queries

4. Mapping Overhead

	- OpenSearch requires schema/mapping design:
	  - keyword vs text
	  - nested vs object


#### Summary

* Pros

	- Best search experience (no regression)
	- JSON preserved in PostgreSQL
	- Strong streaming/pagination
	- Mature backup/restore
	- Scalable search architecture

* Cons

	- More complex system
	- Requires sync pipeline
	- Higher developer learning curve
	- Potential consistency lag

## 4. Head-to-Head Comparison

| Requirement | DocumentDB | Polyglot (Postgres + OpenSearch) |
|------------|-----------|----------------------------------|
| JSON Preservation | Native | JSONB (no flattening) |
| Query Model | Mongo-style ($match) | SQL + JSON + Search DSL |
| Aggregations | Native pipelines | Split across systems |
| Search Experience | Moderate | Best-in-class |
| Cursor / Streaming | Mongo cursors | Advanced search pagination |
| Developer Ergonomics | Excellent | Moderate |
| Architecture Complexity | Low | High |
| Backup / Restore | Good | Strong (Postgres) |
| Migration Risk | Low | Moderate |
| Search Regression Risk | Medium–High | Low |


## 5. Decision Framework


### Choose DocumentDB if:

- Priority is **developer continuity**
- Existing queries are:
  - Structured
  - Aggregation-heavy (not search-heavy)
- Minimal architecture change desired
- Search is **not advanced UX-driven**


### Choose Polyglot if:

- Priority is **zero search regression**
- Need:
  - Full-text search
  - Faceting/filtering
  - Large dataset navigation
- Willing to manage:
  - Data pipelines
  - Dual systems
- CycloneDX data will be **explored/search-heavy**


## 6. Final Recommendation (CycloneDX Context)

For SBOM/CycloneDX workloads involving:

- Component search
- Dependency exploration
- Vulnerability lookups
- Large dataset navigation

### Recommended Architecture

* **RDS PostgreSQL (JSONB) + OpenSearch**

* Rationale
	* CycloneDX is both:
	  - A **document storage problem**
	  - A **search and traversal problem**
	* PostgreSQL preserves raw BOM integrity
	* OpenSearch ensures **no degradation in search UX**


### Alternative (Conservative Migration)

If workload is primarily:

- Document retrieval
- Structured queries
- Minimal search UX complexity

Use: **AWS DocumentDB**


## 7. Key Takeaway

> **DocumentDB optimizes for developer simplicity.**  
> **Polyglot optimizes for search excellence.**

Your decision hinges on which risk matters more:

- **Migration friction → choose DocumentDB**
- **Search regression → choose Polyglot**
