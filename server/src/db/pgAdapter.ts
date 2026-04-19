/**
 * pgAdapter.ts
 *
 * Implements DbAdapter using Amazon RDS PostgreSQL (via the `pg` driver).
 *
 * Schema strategy
 * ───────────────
 * Every document collection is stored in a single table called `documents`
 * with the following columns:
 *
 *   id          TEXT PRIMARY KEY
 *   collection  TEXT NOT NULL
 *   state       TEXT
 *   data        JSONB NOT NULL          ← full document JSON
 *   created_at  TIMESTAMPTZ DEFAULT now()
 *   updated_at  TIMESTAMPTZ DEFAULT now()
 *
 * User groups, group members, and attachments each have their own typed
 * tables for ACID compliance and easy auditing.
 *
 * Why a single `documents` table instead of one table per collection?
 *   • DLMS collections are schema-flexible by design (JSONB preserves that).
 *   • Enterprise governance: a unified table simplifies row-level security,
 *     audit triggers, and backup policies.
 *   • Per-collection views and partial indexes keep query performance high.
 */

import { Pool, PoolClient, QueryResult } from "pg";
import {
  DbAdapter,
  UserGroupCreate,
  UserGroupInfo,
  UserGroupUpdate,
  AttachmentInfo,
  throwErr,
} from "dlms-base-pg";
import { logger } from "../logger";

// ─── Helper ───────────────────────────────────────────────────────────────────

function rowToDoc(row: any): any {
  if (!row) return null;
  const doc = row.data ?? {};
  doc._id = row.id;
  doc._state = row.state;
  doc._createdAt = row.created_at;
  doc._updatedAt = row.updated_at;
  return doc;
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export class PgAdapter implements DbAdapter {
  private pool: Pool;

  constructor(connectionString?: string) {
    this.pool = new Pool({
      connectionString:
        connectionString ??
        process.env.DATABASE_URL ??
        `postgresql://${process.env.PG_USER}:${process.env.PG_PASS}@${process.env.PG_HOST ?? "localhost"}:${process.env.PG_PORT ?? "5432"}/${process.env.PG_DB ?? "dlms"}`,
      max: parseInt(process.env.PG_POOL_MAX ?? "10", 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl:
        process.env.PG_SSL === "true"
          ? { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED !== "false" }
          : undefined,
    });

    this.pool.on("error", (err) => {
      logger.error("Unexpected PG pool error", { err });
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    // Run DDL migrations to ensure schema is up-to-date.
    const client = await this.pool.connect();
    try {
      await this._runMigrations(client);
      logger.info("PostgreSQL connected and schema verified");
    } finally {
      client.release();
    }
  }

  async disconnect(): Promise<void> {
    await this.pool.end();
    logger.info("PostgreSQL pool closed");
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  // ── Documents ──────────────────────────────────────────────────────────────

  async createDoc(collection: string, doc: any): Promise<any> {
    const id: string = doc._id ?? doc.id ?? this._newId();
    const state: string | null = doc._state ?? doc.state ?? null;
    const clean = this._stripMeta(doc);

    const sql = `
      INSERT INTO documents (id, collection, state, data)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (id, collection) DO NOTHING
      RETURNING *`;
    const res: QueryResult = await this.pool.query(sql, [id, collection, state, JSON.stringify(clean)]);

    if (res.rowCount === 0) {
      throwErr(502, `Document with id '${id}' already exists in collection '${collection}'`);
    }
    return rowToDoc(res.rows[0]);
  }

  async getDoc(collection: string, id: string): Promise<any | null> {
    const res = await this.pool.query(
      "SELECT * FROM documents WHERE id = $1 AND collection = $2",
      [id, collection]
    );
    return res.rows.length ? rowToDoc(res.rows[0]) : null;
  }

  async updateDoc(collection: string, id: string, patch: any): Promise<any | null> {
    const existing = await this.getDoc(collection, id);
    if (!existing) return null;

    const cleanPatch = this._stripMeta(patch);
    const merged = { ...this._stripMeta(existing), ...cleanPatch };
    const newState = patch._state ?? patch.state ?? existing._state ?? null;

    const sql = `
      UPDATE documents
      SET data = $1, state = $2, updated_at = now()
      WHERE id = $3 AND collection = $4
      RETURNING *`;
    const res = await this.pool.query(sql, [JSON.stringify(merged), newState, id, collection]);
    return res.rows.length ? rowToDoc(res.rows[0]) : null;
  }

  async deleteDoc(collection: string, id: string): Promise<any | null> {
    const res = await this.pool.query(
      "DELETE FROM documents WHERE id = $1 AND collection = $2 RETURNING *",
      [id, collection]
    );
    return res.rows.length ? rowToDoc(res.rows[0]) : null;
  }

  async listDocs(collection: string, match?: any, projection?: string[]): Promise<any[]> {
    // Basic JSONB containment filter – supports simple equality matches.
    // For complex queries, the OpenSearch adapter should be used.
    if (match && Object.keys(match).length > 0) {
      const sql = `
        SELECT * FROM documents
        WHERE collection = $1 AND data @> $2::jsonb
        ORDER BY created_at DESC`;
      const res = await this.pool.query(sql, [collection, JSON.stringify(this._stripMeta(match))]);
      return res.rows.map(rowToDoc);
    }
    const res = await this.pool.query(
      "SELECT * FROM documents WHERE collection = $1 ORDER BY created_at DESC",
      [collection]
    );
    return res.rows.map(rowToDoc);
  }

  // ── User Groups ────────────────────────────────────────────────────────────

  async createGroup(group: UserGroupCreate): Promise<UserGroupInfo> {
    const sql = `
      INSERT INTO user_groups (id, deletable)
      VALUES ($1, $2)
      ON CONFLICT (id) DO NOTHING
      RETURNING *`;
    const res = await this.pool.query(sql, [group.id, group.deletable ?? true]);
    if (res.rowCount === 0) throwErr(400, `User group '${group.id}' already exists`);

    if (group.members && group.members.length > 0) {
      await this._upsertMembers(group.id, group.members);
    }
    return this._loadGroup(group.id) as Promise<UserGroupInfo>;
  }

  async getGroup(id: string): Promise<UserGroupInfo | null> {
    return this._loadGroup(id);
  }

  async updateGroup(id: string, patch: UserGroupUpdate): Promise<UserGroupInfo | null> {
    const existing = await this._loadGroup(id);
    if (!existing) return null;

    if (patch.members !== undefined) {
      // Replace all members
      await this.pool.query("DELETE FROM user_group_members WHERE group_id = $1", [id]);
      if (patch.members.length > 0) {
        await this._upsertMembers(id, patch.members);
      }
    }
    return this._loadGroup(id);
  }

  async deleteGroup(id: string): Promise<UserGroupInfo | null> {
    const group = await this._loadGroup(id);
    if (!group) return null;
    if (!group.deletable) throwErr(403, `User group '${id}' is marked undeletable`);

    await this.pool.query("DELETE FROM user_group_members WHERE group_id = $1", [id]);
    await this.pool.query("DELETE FROM user_groups WHERE id = $1", [id]);
    return group;
  }

  async listGroups(): Promise<UserGroupInfo[]> {
    const res = await this.pool.query("SELECT id FROM user_groups ORDER BY id");
    const groups = await Promise.all(res.rows.map((r) => this._loadGroup(r.id)));
    return groups.filter(Boolean) as UserGroupInfo[];
  }

  // ── Attachments ────────────────────────────────────────────────────────────

  async createAttachment(info: Omit<AttachmentInfo, "id">): Promise<AttachmentInfo> {
    const id = this._newId();
    const sql = `
      INSERT INTO attachments (id, name, mime_type, size, doc_id, collection, s3_key)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *`;
    const res = await this.pool.query(sql, [
      id,
      info.name,
      info.mimeType,
      info.size,
      info.docId,
      info.collection,
      info.s3Key ?? null,
    ]);
    return this._rowToAttachment(res.rows[0]);
  }

  async getAttachment(id: string): Promise<AttachmentInfo | null> {
    const res = await this.pool.query("SELECT * FROM attachments WHERE id = $1", [id]);
    return res.rows.length ? this._rowToAttachment(res.rows[0]) : null;
  }

  async deleteAttachment(id: string): Promise<AttachmentInfo | null> {
    const res = await this.pool.query("DELETE FROM attachments WHERE id = $1 RETURNING *", [id]);
    return res.rows.length ? this._rowToAttachment(res.rows[0]) : null;
  }

  async listAttachmentsByDoc(collection: string, docId: string): Promise<AttachmentInfo[]> {
    const res = await this.pool.query(
      "SELECT * FROM attachments WHERE collection = $1 AND doc_id = $2 ORDER BY created_at",
      [collection, docId]
    );
    return res.rows.map(this._rowToAttachment);
  }

  async listAllAttachments(): Promise<AttachmentInfo[]> {
    const res = await this.pool.query("SELECT * FROM attachments ORDER BY created_at DESC");
    return res.rows.map(this._rowToAttachment);
  }

  // ── Admin ──────────────────────────────────────────────────────────────────

  async exportAll(): Promise<{ [collection: string]: any[] }> {
    const res = await this.pool.query(
      "SELECT DISTINCT collection FROM documents ORDER BY collection"
    );
    const result: { [col: string]: any[] } = {};
    for (const row of res.rows) {
      result[row.collection] = await this.listDocs(row.collection);
    }
    // Include user groups
    result["__user_groups"] = await this.listGroups();
    return result;
  }

  async importAll(data: { [collection: string]: any[] }): Promise<void> {
    for (const [collection, docs] of Object.entries(data)) {
      if (collection === "__user_groups") {
        for (const g of docs as any[]) {
          try {
            await this.createGroup(g);
          } catch {
            // skip duplicates
          }
        }
        continue;
      }
      for (const doc of docs) {
        try {
          await this.createDoc(collection, doc);
        } catch {
          // skip duplicates
        }
      }
    }
  }

  async dropAll(): Promise<void> {
    await this.pool.query("TRUNCATE documents, user_group_members, user_groups, attachments CASCADE");
    logger.warn("All DLMS data dropped from PostgreSQL");
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async _runMigrations(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS documents (
        id          TEXT NOT NULL,
        collection  TEXT NOT NULL,
        state       TEXT,
        data        JSONB NOT NULL DEFAULT '{}',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (id, collection)
      );

      CREATE INDEX IF NOT EXISTS idx_docs_collection ON documents (collection);
      CREATE INDEX IF NOT EXISTS idx_docs_state      ON documents (collection, state);
      CREATE INDEX IF NOT EXISTS idx_docs_data       ON documents USING gin (data);

      CREATE TABLE IF NOT EXISTS user_groups (
        id        TEXT PRIMARY KEY,
        deletable BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS user_group_members (
        group_id        TEXT NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
        email           TEXT NOT NULL,
        name            TEXT,
        department      TEXT,
        title           TEXT,
        employee_number TEXT,
        PRIMARY KEY (group_id, email)
      );

      CREATE TABLE IF NOT EXISTS attachments (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        mime_type   TEXT,
        size        BIGINT,
        doc_id      TEXT NOT NULL,
        collection  TEXT NOT NULL,
        s3_key      TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_att_doc ON attachments (collection, doc_id);
    `);
  }

  private async _loadGroup(id: string): Promise<UserGroupInfo | null> {
    const gRes = await this.pool.query("SELECT * FROM user_groups WHERE id = $1", [id]);
    if (!gRes.rows.length) return null;
    const g = gRes.rows[0];

    const mRes = await this.pool.query(
      "SELECT * FROM user_group_members WHERE group_id = $1 ORDER BY email",
      [id]
    );
    return {
      id: g.id,
      deletable: g.deletable,
      members: mRes.rows.map((r) => ({
        email: r.email,
        name: r.name ?? "",
        department: r.department ?? "",
        title: r.title ?? "",
        employeeNumber: r.employee_number ?? "",
      })),
    };
  }

  private async _upsertMembers(groupId: string, members: any[]): Promise<void> {
    for (const m of members) {
      await this.pool.query(
        `INSERT INTO user_group_members (group_id, email, name, department, title, employee_number)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (group_id, email) DO UPDATE
           SET name=$3, department=$4, title=$5, employee_number=$6`,
        [groupId, m.email, m.name ?? "", m.department ?? "", m.title ?? "", m.employeeNumber ?? ""]
      );
    }
  }

  private _stripMeta(doc: any): any {
    const { _id, _state, _createdAt, _updatedAt, id, state, ...rest } = doc;
    return rest;
  }

  private _newId(): string {
    return require("uuid").v4();
  }

  private _rowToAttachment(row: any): AttachmentInfo {
    return {
      id: row.id,
      name: row.name,
      mimeType: row.mime_type,
      size: Number(row.size),
      docId: row.doc_id,
      collection: row.collection,
      s3Key: row.s3_key,
      createdAt: row.created_at?.toISOString(),
      updatedAt: row.updated_at?.toISOString(),
    };
  }
}
