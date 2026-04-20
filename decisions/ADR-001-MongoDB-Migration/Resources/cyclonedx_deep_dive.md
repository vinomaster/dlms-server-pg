# 🧩 CycloneDX Deep Implementation Layer

## Prompt
How would the proposed architecture solutions map to our CycloneDX JSON use case? Specifically, we seek clarity on the concrete differences (especially around $match, nested structures, and search indexing).

## Response Overview
Two critical areas are relavent:

1. **Data Modeling**
   - CycloneDX JSON → PostgreSQL JSONB + OpenSearch index design

2. **Query Translation**
   - MongoDB `$match / $unwind / $group` → SQL + OpenSearch DSL


## 🏗️ 1. CycloneDX → Polyglot Data Model

### Source Example (Simplified CycloneDX JSON)

```json
{
  "bomFormat": "CycloneDX",
  "specVersion": "1.6",
  "components": [
    {
      "name": "log4j",
      "version": "2.14.1",
      "licenses": [
        { "license": { "id": "Apache-2.0" } }
      ],
      "vulnerabilities": [
        { "id": "CVE-2021-44228", "severity": "CRITICAL" }
      ]
    }
  ]
}
```

### 🟦 PostgreSQL (JSONB) – Source of Truth

Using PostgreSQL via Amazon RDS

#### Table Design

```sql
CREATE TABLE sbom_documents (
    id UUID PRIMARY KEY,
    created_at TIMESTAMP,
    bom JSONB
);
```

#### Indexing Strategy

```sql
-- GIN index for JSONB queries
CREATE INDEX idx_sbom_jsonb ON sbom_documents USING GIN (bom);

-- Targeted index for common queries
CREATE INDEX idx_components_name 
ON sbom_documents USING GIN ((bom->'components'));
```

👉 Reality:
- JSONB works, but **deep nested queries get expensive**
- Requires careful indexing + query shaping


### 🟨 OpenSearch – Search Projection Layer

#### Flattened Index Design

```json
{
  "sbom_id": "uuid",
  "component_name": "log4j",
  "version": "2.14.1",
  "license": "Apache-2.0",
  "vulnerability_id": "CVE-2021-44228",
  "severity": "CRITICAL"
}
```

#### Key Design Principle

👉 **Explode arrays into searchable documents**

Each component → multiple index records


### 🔄 Data Flow

```text
Ingest SBOM JSON
    ↓
Store full document (Postgres JSONB)
    ↓
Transform + flatten
    ↓
Index into OpenSearch
```


### ⚠️ Critical Tradeoff

| Concern | Impact |
|--------|--------|
| Data duplication | Required |
| Sync latency | Eventual consistency |
| Complexity | High |
| Performance payoff | Massive for search/analytics |


## 🔍 2. Query Translation Layer


### 🎯 Use Case 1: License Search

#### MongoDB

```javascript
db.sbom.aggregate([
  { $unwind: "$components" },
  { $unwind: "$components.licenses" },
  { $match: { "components.licenses.license.id": "Apache-2.0" } }
])
```


#### PostgreSQL (JSONB)

```sql
SELECT *
FROM sbom_documents
WHERE bom @> '{
  "components": [
    {
      "licenses": [
        { "license": { "id": "Apache-2.0" } }
      ]
    }
  ]
}';
```

👉 Limitation:
- Not as expressive for deep filtering
- Can degrade with complex nesting


#### OpenSearch

```json
{
  "query": {
    "term": {
      "license": "Apache-2.0"
    }
  }
}
```

👉 Advantage:
- Extremely fast
- Built for this exact pattern


### 🎯 Use Case 2: Vulnerability Aggregation


#### MongoDB

```javascript
db.sbom.aggregate([
  { $unwind: "$components" },
  { $unwind: "$components.vulnerabilities" },
  { $group: {
      _id: "$components.vulnerabilities.severity",
      count: { $sum: 1 }
  }}
])
```


#### PostgreSQL

```sql
SELECT
  vuln->>'severity' AS severity,
  COUNT(*)
FROM sbom_documents,
LATERAL jsonb_array_elements(bom->'components') comp,
LATERAL jsonb_array_elements(comp->'vulnerabilities') vuln
GROUP BY severity;
```

👉 Reality:
- Powerful but **not intuitive**
- Harder to maintain


#### OpenSearch

```json
{
  "aggs": {
    "severity_count": {
      "terms": {
        "field": "severity.keyword"
      }
    }
  }
}
```

👉 Best-in-class for aggregation


### 🎯 Use Case 3: Hybrid Query (Search + Full Document)


#### Polyglot Pattern

```text
1. Query OpenSearch → get sbom_id list
2. Query Postgres → fetch full JSON documents
```


#### Example

##### Step 1 – OpenSearch

```json
{
  "query": {
    "term": { "severity": "CRITICAL" }
  }
}
```

##### Step 2 – PostgreSQL

```sql
SELECT * 
FROM sbom_documents 
WHERE id IN (...);
```


### ⚠️ Key Tradeoff

| Pattern | MongoDB | Polyglot |
|--------|--------|----------|
| Single query | Yes | No |
| Performance | Moderate | High |
| Complexity | Low | High |


## 🧠 Final Architecture Insight

### Where Each Wins (CycloneDX Reality)

| Requirement | Winner |
|------------|--------|
| Native JSON + dev speed | MongoDB |
| MongoDB compatibility | DocumentDB |
| Search + analytics at scale | Polyglot |
| Governance + compliance | Polyglot |
| Lowest migration effort | DocumentDB |


## 🚨 Bottom-Line (No Sugarcoating)

- **MongoDB** → Best developer experience, weakest enterprise posture at scale  
- **DocumentDB** → Transitional, but risky for complex aggregation workloads  
- **Polyglot** → Architecturally correct for enterprise, but requires discipline  
