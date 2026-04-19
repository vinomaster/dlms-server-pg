/**
 * backup/src/index.ts
 *
 * DLMS Polyglot Backup & Restore Utilities
 * ────────────────────────────────────────
 *
 * backup()
 *   1. Runs a logical JSON export of the PostgreSQL `documents` table and
 *      all related tables via SELECT … JSON.
 *   2. Gzip-compresses the export.
 *   3. Uploads to S3 at  s3://<BACKUP_BUCKET>/<prefix>/<timestamp>.json.gz
 *   Note: For large datasets prefer AWS RDS automated snapshots (configured
 *   via Terraform in infra/).  This utility is for lightweight logical
 *   backups and point-in-time application exports.
 *
 * restore()
 *   1. Downloads a named backup from S3.
 *   2. Decompresses and parses JSON.
 *   3. Truncates the target PostgreSQL tables.
 *   4. Inserts all records.
 *   5. Triggers OpenSearch reindex.
 *
 * reindex()
 *   Reads all documents from PostgreSQL and pushes them to OpenSearch.
 *   Use after an OpenSearch domain is replaced or after bulk data changes.
 *
 * Environment variables
 * ─────────────────────
 *   DATABASE_URL         PostgreSQL connection string
 *   BACKUP_BUCKET        S3 bucket for backups
 *   BACKUP_PREFIX        S3 key prefix (default: "dlms-backups")
 *   OPENSEARCH_ENDPOINT  OpenSearch cluster URL
 *   AWS_REGION           AWS region
 */

import { Pool } from "pg";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { Client as OsClient } from "@opensearch-project/opensearch";
import { createGzip, createGunzip } from "zlib";
import { pipeline, Readable, Writable } from "stream";
import { promisify } from "util";
import winston from "winston";

const pipe = promisify(pipeline);

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level}]: ${message}`)
  ),
  transports: [new winston.transports.Console()],
});

// ── Connection helpers ────────────────────────────────────────────────────────

function makePgPool(): Pool {
  return new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      `postgresql://${process.env.PG_USER}:${process.env.PG_PASS}@${process.env.PG_HOST ?? "localhost"}:${process.env.PG_PORT ?? "5432"}/${process.env.PG_DB ?? "dlms"}`,
    ssl: process.env.PG_SSL === "true" ? { rejectUnauthorized: false } : undefined,
  });
}

function makeS3(): S3Client {
  const config: any = { region: process.env.AWS_REGION ?? "us-east-1" };
  if (process.env.S3_ENDPOINT) {
    config.endpoint = process.env.S3_ENDPOINT;
    config.forcePathStyle = true;
  }
  return new S3Client(config);
}

function makeOsClient(): OsClient {
  return new OsClient({
    node: process.env.OPENSEARCH_ENDPOINT ?? "http://localhost:9200",
    auth:
      process.env.OPENSEARCH_USER
        ? { username: process.env.OPENSEARCH_USER!, password: process.env.OPENSEARCH_PASS! }
        : undefined,
  });
}

// ── Backup ────────────────────────────────────────────────────────────────────

export async function backup(label?: string): Promise<string> {
  const pool = makePgPool();
  const s3 = makeS3();
  const bucket = process.env.BACKUP_BUCKET ?? "dlms-backups";
  const prefix = process.env.BACKUP_PREFIX ?? "dlms-backups";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const key = `${prefix}/${label ?? "auto"}/${timestamp}.json.gz`;

  logger.info("Starting PostgreSQL logical backup");

  try {
    // Export all tables as JSON
    const [docsRes, groupsRes, membersRes, attRes] = await Promise.all([
      pool.query("SELECT * FROM documents ORDER BY collection, created_at"),
      pool.query("SELECT * FROM user_groups ORDER BY id"),
      pool.query("SELECT * FROM user_group_members ORDER BY group_id, email"),
      pool.query("SELECT * FROM attachments ORDER BY collection, created_at"),
    ]);

    const payload = JSON.stringify(
      {
        version: "1.0",
        timestamp: new Date().toISOString(),
        appName: process.env.APP_NAME ?? "dlms",
        documents: docsRes.rows,
        userGroups: groupsRes.rows,
        userGroupMembers: membersRes.rows,
        attachments: attRes.rows,
      },
      null,
      2
    );

    // Gzip and upload to S3
    const gzBuffer = await gzip(Buffer.from(payload, "utf-8"));

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: gzBuffer,
        ContentType: "application/gzip",
        ContentEncoding: "gzip",
        ServerSideEncryption: "aws:kms",
        Metadata: {
          "dlms-timestamp": timestamp,
          "dlms-app": process.env.APP_NAME ?? "dlms",
          "dlms-doc-count": String(docsRes.rowCount),
        },
      })
    );

    logger.info(`Backup complete: s3://${bucket}/${key}`);
    logger.info(`  Documents:  ${docsRes.rowCount}`);
    logger.info(`  Groups:     ${groupsRes.rowCount}`);
    logger.info(`  Attachments:${attRes.rowCount}`);

    return key;
  } finally {
    await pool.end();
  }
}

// ── Restore ───────────────────────────────────────────────────────────────────

export async function restore(s3Key: string, dryRun = false): Promise<void> {
  const pool = makePgPool();
  const s3 = makeS3();
  const bucket = process.env.BACKUP_BUCKET ?? "dlms-backups";

  logger.info(`Restoring from s3://${bucket}/${s3Key}${dryRun ? " [DRY RUN]" : ""}`);

  try {
    // Download and decompress
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: s3Key }));
    const compressed = await streamToBuffer(obj.Body as Readable);
    const raw = await gunzip(compressed);
    const data = JSON.parse(raw.toString("utf-8"));

    logger.info(`Backup metadata: version=${data.version}, timestamp=${data.timestamp}`);
    logger.info(`  Documents:  ${data.documents?.length}`);
    logger.info(`  Groups:     ${data.userGroups?.length}`);
    logger.info(`  Attachments:${data.attachments?.length}`);

    if (dryRun) {
      logger.info("Dry run complete – no data written");
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Truncate in dependency order
      await client.query("TRUNCATE user_group_members, attachments, documents CASCADE");
      await client.query("TRUNCATE user_groups CASCADE");

      // Restore user groups
      for (const g of data.userGroups ?? []) {
        await client.query(
          "INSERT INTO user_groups (id, deletable, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
          [g.id, g.deletable, g.created_at]
        );
      }

      // Restore group members
      for (const m of data.userGroupMembers ?? []) {
        await client.query(
          `INSERT INTO user_group_members (group_id, email, name, department, title, employee_number)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [m.group_id, m.email, m.name, m.department, m.title, m.employee_number]
        );
      }

      // Restore documents
      for (const d of data.documents ?? []) {
        await client.query(
          `INSERT INTO documents (id, collection, state, data, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [d.id, d.collection, d.state, d.data, d.created_at, d.updated_at]
        );
      }

      // Restore attachment metadata (S3 objects remain intact)
      for (const a of data.attachments ?? []) {
        await client.query(
          `INSERT INTO attachments (id, name, mime_type, size, doc_id, collection, s3_key, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
          [a.id, a.name, a.mime_type, a.size, a.doc_id, a.collection, a.s3_key, a.created_at, a.updated_at]
        );
      }

      await client.query("COMMIT");
      logger.info("PostgreSQL restore complete");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    // Reindex OpenSearch
    await reindex();
  } finally {
    await pool.end();
  }
}

// ── Reindex ───────────────────────────────────────────────────────────────────

export async function reindex(): Promise<void> {
  const pool = makePgPool();
  const os = makeOsClient();

  logger.info("Starting OpenSearch reindex from PostgreSQL");

  try {
    const collectionsRes = await pool.query(
      "SELECT DISTINCT collection FROM documents ORDER BY collection"
    );
    const collections: string[] = collectionsRes.rows.map((r: any) => r.collection);

    for (const collection of collections) {
      const docsRes = await pool.query(
        "SELECT * FROM documents WHERE collection = $1",
        [collection]
      );
      const index = `dlms_${collection.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`;

      // Delete existing index if present
      try {
        await os.indices.delete({ index });
      } catch {
        // didn't exist – fine
      }

      if (docsRes.rows.length === 0) continue;

      // Create index
      await os.indices.create({
        index,
        body: {
          settings: { number_of_shards: 1, number_of_replicas: 1 },
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

      // Bulk index
      const body = docsRes.rows.flatMap((row: any) => {
        const doc = { ...row.data, _id: row.id, _state: row.state, _collection: collection };
        return [{ index: { _index: index, _id: row.id } }, doc];
      });

      const { body: bulkRes } = await os.bulk({ body, refresh: "wait_for" });
      if (bulkRes.errors) {
        logger.warn(`Some docs failed to index in collection '${collection}'`);
      }

      logger.info(`Reindexed ${docsRes.rowCount} docs → '${index}'`);
    }

    logger.info("OpenSearch reindex complete");
  } finally {
    await pool.end();
    await os.close();
  }
}

// ── List backups ──────────────────────────────────────────────────────────────

export async function listBackups(): Promise<string[]> {
  const s3 = makeS3();
  const bucket = process.env.BACKUP_BUCKET ?? "dlms-backups";
  const prefix = process.env.BACKUP_PREFIX ?? "dlms-backups";

  const res = await s3.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix })
  );
  return (res.Contents ?? []).map((o) => o.Key!).filter(Boolean);
}

// ── Utility ───────────────────────────────────────────────────────────────────

function gzip(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const gz = createGzip();
    const chunks: Buffer[] = [];
    gz.on("data", (c) => chunks.push(c));
    gz.on("end", () => resolve(Buffer.concat(chunks)));
    gz.on("error", reject);
    gz.end(input);
  });
}

function gunzip(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const gz = createGunzip();
    const chunks: Buffer[] = [];
    gz.on("data", (c) => chunks.push(c));
    gz.on("end", () => resolve(Buffer.concat(chunks)));
    gz.on("error", reject);
    gz.end(input);
  });
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
