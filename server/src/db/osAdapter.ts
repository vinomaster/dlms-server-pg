/**
 * osAdapter.ts
 *
 * Implements SearchAdapter using Amazon OpenSearch Service
 * (API-compatible with OpenSearch 2.x via @opensearch-project/opensearch).
 *
 * Indexing strategy
 * ─────────────────
 *   • Each DLMS collection maps to a single OpenSearch index named
 *     `dlms_<collection>`.
 *   • The entire document JSON (plus `_id`, `_state`, `_collection`) is
 *     indexed so full-text and field-level search work without a secondary
 *     lookup.
 *   • After every write (create / update / delete) in DocMgr, the OS index
 *     is updated asynchronously so that the RDS PostgreSQL record is always
 *     the authoritative source of truth.
 *
 * Environment variables
 * ─────────────────────
 *   OPENSEARCH_ENDPOINT   Full URL, e.g. https://search-xxx.us-east-1.es.amazonaws.com
 *   OPENSEARCH_USER       (optional) HTTP basic auth username
 *   OPENSEARCH_PASS       (optional) HTTP basic auth password
 *   OPENSEARCH_USE_AWS_AUTH  "true" to use AWS SigV4 signing (recommended for AOSS)
 *   AWS_REGION            Used for SigV4
 */

import { Client } from "@opensearch-project/opensearch";
import { SearchAdapter } from "dlms-base-pg";
import { logger } from "../logger";

export class OsAdapter implements SearchAdapter {
  private client: Client;

  constructor(endpointOverride?: string) {
    const endpoint =
      endpointOverride ??
      process.env.OPENSEARCH_ENDPOINT ??
      "http://localhost:9200";

    const clientConfig: any = { node: endpoint };

    if (process.env.OPENSEARCH_USER && process.env.OPENSEARCH_PASS) {
      clientConfig.auth = {
        username: process.env.OPENSEARCH_USER,
        password: process.env.OPENSEARCH_PASS,
      };
    }

    // AWS SigV4 signing (for Amazon OpenSearch Service / Serverless)
    if (process.env.OPENSEARCH_USE_AWS_AUTH === "true") {
      // The AWS credentials are picked up automatically from the execution
      // environment (EC2 instance role, ECS task role, Lambda role, etc.)
      // via the AWS SDK default credential chain.
      const { defaultProvider } = require("@aws-sdk/credential-provider-node");
      const { AwsSigv4Signer } = require("@opensearch-project/opensearch/aws");
      Object.assign(clientConfig, {
        ...AwsSigv4Signer({
          region: process.env.AWS_REGION ?? "us-east-1",
          service: "es", // use "aoss" for OpenSearch Serverless
          getCredentials: defaultProvider(),
        }),
      });
    }

    this.client = new Client(clientConfig);
  }

  async connect(): Promise<void> {
    const ok = await this.healthCheck();
    if (!ok) throw new Error("OpenSearch cluster is not reachable");
    logger.info("OpenSearch connected");
  }

  async disconnect(): Promise<void> {
    await this.client.close();
  }

  async healthCheck(): Promise<boolean> {
    try {
      const { body } = await this.client.cluster.health({});
      return ["green", "yellow"].includes(body.status);
    } catch {
      return false;
    }
  }

  async indexDoc(collection: string, doc: any): Promise<void> {
    const index = this._indexName(collection);
    await this._ensureIndex(index);
    await this.client.index({
      index,
      id: doc._id ?? doc.id,
      body: { ...doc, _collection: collection },
      refresh: "wait_for",
    });
  }

  async updateIndexedDoc(collection: string, id: string, doc: any): Promise<void> {
    const index = this._indexName(collection);
    try {
      await this.client.update({
        index,
        id,
        body: { doc: { ...doc, _collection: collection }, doc_as_upsert: true },
        refresh: "wait_for",
      });
    } catch (err: any) {
      // If doc doesn't exist yet (e.g. OS was down during creation), index fresh
      if (err?.statusCode === 404) {
        await this.indexDoc(collection, doc);
      } else {
        throw err;
      }
    }
  }

  async deleteIndexedDoc(collection: string, id: string): Promise<void> {
    const index = this._indexName(collection);
    try {
      await this.client.delete({ index, id, refresh: "wait_for" });
    } catch (err: any) {
      if (err?.statusCode !== 404) throw err;
    }
  }

  /**
   * Full-text + structured search.
   *
   * @param query  Free-text query string (searched across all fields)
   * @param filters  Optional field-level filters, e.g. { _state: "approved" }
   */
  async search(collection: string, query: string, filters?: any): Promise<any[]> {
    const index = this._indexName(collection);
    const must: any[] = [];

    if (query && query.trim()) {
      must.push({
        multi_match: {
          query,
          fields: ["*"],
          type: "best_fields",
          fuzziness: "AUTO",
        },
      });
    }

    if (filters) {
      for (const [key, val] of Object.entries(filters)) {
        must.push({ match: { [key]: val } });
      }
    }

    const body: any =
      must.length > 0 ? { query: { bool: { must } } } : { query: { match_all: {} } };

    try {
      const { body: res } = await this.client.search({ index, body, size: 100 });
      return (res.hits?.hits ?? []).map((h: any) => ({ ...h._source, _score: h._score }));
    } catch (err: any) {
      // Index doesn't exist yet – return empty
      if (err?.statusCode === 404) return [];
      throw err;
    }
  }

  async reindex(collection: string, docs: any[]): Promise<void> {
    const index = this._indexName(collection);
    await this._ensureIndex(index);

    if (docs.length === 0) return;

    const body = docs.flatMap((doc) => [
      { index: { _index: index, _id: doc._id ?? doc.id } },
      { ...doc, _collection: collection },
    ]);

    const { body: res } = await this.client.bulk({ body, refresh: "wait_for" });
    if (res.errors) {
      const errs = res.items
        .filter((i: any) => i.index?.error)
        .map((i: any) => i.index.error);
      logger.error("OpenSearch bulk reindex errors", { errs });
    }
    logger.info(`Reindexed ${docs.length} docs in index '${index}'`);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _indexName(collection: string): string {
    return `dlms_${collection.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`;
  }

  private async _ensureIndex(index: string): Promise<void> {
    const { body: exists } = await this.client.indices.exists({ index });
    if (!exists) {
      await this.client.indices.create({
        index,
        body: {
          settings: {
            number_of_shards: 1,
            number_of_replicas: parseInt(process.env.OPENSEARCH_REPLICAS ?? "1", 10),
          },
          mappings: {
            dynamic: true,
            properties: {
              _id:         { type: "keyword" },
              _state:      { type: "keyword" },
              _collection: { type: "keyword" },
              _createdAt:  { type: "date" },
              _updatedAt:  { type: "date" },
            },
          },
        },
      });
      logger.info(`Created OpenSearch index '${index}'`);
    }
  }
}
