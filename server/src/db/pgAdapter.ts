/**
 * Copyright (c) 2024 Discover Financial Services
 *
 * PgAdapter — PostgreSQL implementation of the DLMS collection interface.
 *
 * Design goal: expose the same duck-typed "collection" API that the original
 * docMgr used against MongoDB, so that docMgr requires minimal changes:
 *
 *   collection.insertOne(doc)          → INSERT, returns id
 *   collection.findOne(id)             → SELECT by id
 *   collection.findOneWhere(filter)    → SELECT with WHERE
 *   collection.find(match, options)    → SELECT with optional filter/sort/limit/projection
 *   collection.updateOne(id, update)   → UPDATE with $set / $push / $pull / $unset
 *   collection.upsertOne(id, doc)      → INSERT ON CONFLICT DO UPDATE
 *   collection.deleteOne(id)           → DELETE by id
 *   collection.deleteMany(match)       → DELETE with WHERE
 *   collection.drop()                  → DELETE all rows for this collection
 *
 * For user-group collections the same table is used; rows are differentiated
 * by their `collection` column.
 *
 * Schema (single `dlms_documents` table for all collections):
 *
 *   id          TEXT PRIMARY KEY (per collection)
 *   collection  TEXT NOT NULL
 *   data        JSONB NOT NULL    ← full document, _id included as 'id' field
 *   created_at  TIMESTAMPTZ
 *   updated_at  TIMESTAMPTZ
 *
 * PRIMARY KEY is (id, collection).
 */

import { Pool, PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../logger';

const log = new Logger('pgAdapter');

// ── Schema DDL ────────────────────────────────────────────────────────────────

const DDL = `
CREATE TABLE IF NOT EXISTS dlms_documents (
    id          TEXT NOT NULL,
    collection  TEXT NOT NULL,
    data        JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, collection)
);
CREATE INDEX IF NOT EXISTS idx_dlms_collection   ON dlms_documents (collection);
CREATE INDEX IF NOT EXISTS idx_dlms_data_gin     ON dlms_documents USING gin (data);
`;

// ── PgCollection (returned by PgAdapter.collection()) ────────────────────────

export class PgCollection {
    constructor(private pool: Pool, private collectionName: string) {}

    /**
     * Insert a document; auto-generates an id if none present.
     * Returns the id of the inserted document.
     */
    async insertOne(doc: any): Promise<string> {
        // Normalise id field: accept either _id or id
        let id = doc._id ?? doc.id;
        if (!id) { id = uuidv4(); }
        id = String(id);

        // Strip id fields from the data payload – the canonical id lives in the PK column
        const data = { ...doc };
        delete data._id;
        delete data.id;
        // Store _id in data as well so export/import round-trips correctly
        data._id = id;

        const sql = `
            INSERT INTO dlms_documents (id, collection, data)
            VALUES ($1, $2, $3)
            ON CONFLICT (id, collection) DO NOTHING
            RETURNING id`;
        const res = await this.pool.query(sql, [id, this.collectionName, JSON.stringify(data)]);
        if (res.rowCount === 0) {
            log.debug(`insertOne: ${id} already exists in ${this.collectionName}`);
        }
        return id;
    }

    /** Upsert a document (used by importId). */
    async upsertOne(id: string, doc: any): Promise<void> {
        id = String(id);
        const data = { ...doc, _id: id };
        delete data.id;
        const sql = `
            INSERT INTO dlms_documents (id, collection, data, updated_at)
            VALUES ($1, $2, $3, now())
            ON CONFLICT (id, collection) DO UPDATE
              SET data = EXCLUDED.data, updated_at = now()`;
        await this.pool.query(sql, [id, this.collectionName, JSON.stringify(data)]);
    }

    /** Find a single document by its id. */
    async findOne(id: string, projection?: any): Promise<any | null> {
        id = String(id);
        const res = await this.pool.query(
            'SELECT data FROM dlms_documents WHERE id = $1 AND collection = $2',
            [id, this.collectionName]
        );
        if (!res.rows.length) { return null; }
        return applyProjection(res.rows[0].data, projection);
    }

    /** Find a single document matching a filter object. */
    async findOneWhere(filter: any): Promise<any | null> {
        const where = buildWhere(filter);
        const sql = `SELECT data FROM dlms_documents WHERE collection = $1 AND ${where.clause} LIMIT 1`;
        const res = await this.pool.query(sql, [this.collectionName, ...where.values]);
        if (!res.rows.length) { return null; }
        return res.rows[0].data;
    }

    /**
     * Find documents matching an optional filter.
     * `match` is a plain object (field→value equality checks).
     * `options` may contain { sort, projection, limit }.
     * Returns an array of plain document objects.
     */
    async find(match: any, options: any): Promise<any[]> {
        const params: any[] = [this.collectionName];
        let sql = 'SELECT data FROM dlms_documents WHERE collection = $1';

        // Build WHERE clauses from match
        if (match && Object.keys(match).length > 0) {
            const { clause, values } = buildWhere(match, params.length);
            sql += ` AND (${clause})`;
            params.push(...values);
        }

        // ORDER BY
        if (options?.sort) {
            const sortClauses = buildSort(options.sort);
            if (sortClauses) { sql += ` ORDER BY ${sortClauses}`; }
        } else {
            sql += ` ORDER BY created_at`;
        }

        // LIMIT
        if (options?.limit) {
            params.push(options.limit);
            sql += ` LIMIT $${params.length}`;
        }

        const res = await this.pool.query(sql, params);
        return res.rows.map(r => applyProjection(r.data, options?.projection));
    }

    /**
     * Update a document by id.
     * `update` is the result of docMgr.toDbUpdate() and may contain:
     *   $set   { field: value, ... }
     *   $push  { arrayField: item } or { arrayField: { $each: [...] } }
     *   $pull  { arrayField: { id: x } }
     *   $unset { field: '' }
     */
    async updateOne(id: string, update: any): Promise<void> {
        id = String(id);
        const res = await this.pool.query(
            'SELECT data FROM dlms_documents WHERE id = $1 AND collection = $2',
            [id, this.collectionName]
        );
        if (!res.rows.length) {
            log.debug(`updateOne: ${id} not found in ${this.collectionName}`);
            return;
        }
        let data = res.rows[0].data;

        // Apply $set
        if (update.$set) {
            for (const [key, val] of Object.entries(update.$set)) {
                setNestedField(data, key, val);
            }
        }

        // Apply $unset
        if (update.$unset) {
            for (const key of Object.keys(update.$unset)) {
                deleteNestedField(data, key);
            }
        }

        // Apply $push
        if (update.$push) {
            for (const [key, val] of Object.entries(update.$push)) {
                const arr = getNestedField(data, key) || [];
                if (val && typeof val === 'object' && (val as any).$each) {
                    arr.push(...(val as any).$each);
                } else {
                    arr.push(val);
                }
                setNestedField(data, key, arr);
            }
        }

        // Apply $pull
        if (update.$pull) {
            for (const [key, val] of Object.entries(update.$pull)) {
                let arr = getNestedField(data, key) || [];
                if (val && typeof val === 'object') {
                    const filterKeys = Object.keys(val as any);
                    arr = arr.filter((item: any) => {
                        for (const fk of filterKeys) {
                            if (item[fk] === (val as any)[fk]) { return false; }
                        }
                        return true;
                    });
                }
                setNestedField(data, key, arr);
            }
        }

        await this.pool.query(
            'UPDATE dlms_documents SET data = $1, updated_at = now() WHERE id = $2 AND collection = $3',
            [JSON.stringify(data), id, this.collectionName]
        );
    }

    /** Delete a single document by id. */
    async deleteOne(id: string): Promise<void> {
        id = String(id);
        await this.pool.query(
            'DELETE FROM dlms_documents WHERE id = $1 AND collection = $2',
            [id, this.collectionName]
        );
    }

    /** Delete all documents matching a filter. Returns count. */
    async deleteMany(match: any): Promise<number> {
        const params: any[] = [this.collectionName];
        let sql = 'DELETE FROM dlms_documents WHERE collection = $1';
        if (match && Object.keys(match).length > 0) {
            const { clause, values } = buildWhere(match, params.length);
            sql += ` AND (${clause})`;
            params.push(...values);
        }
        const res = await this.pool.query(sql, params);
        return res.rowCount ?? 0;
    }

    /** Drop all documents in this collection. */
    async drop(): Promise<void> {
        await this.pool.query(
            'DELETE FROM dlms_documents WHERE collection = $1',
            [this.collectionName]
        );
        log.debug(`Dropped collection ${this.collectionName}`);
    }

    /** User-group-specific: insert a user group document. */
    async insertUserGroup(group: any): Promise<void> {
        await this.insertOne({ ...group, _id: group.id });
    }

    /** User-group-specific: find all groups. */
    async findAllGroups(): Promise<any[]> {
        return this.find({}, {});
    }
}

// ── PgAdapter ─────────────────────────────────────────────────────────────────

export class PgAdapter {
    private pool: Pool;
    private migrated = false;

    constructor(connectionString?: string) {
        const connStr = connectionString
            ?? process.env.DATABASE_URL
            ?? buildConnStr();
        this.pool = new Pool({
            connectionString: connStr,
            max: parseInt(process.env.PG_POOL_MAX ?? '10', 10),
            idleTimeoutMillis: 30_000,
            connectionTimeoutMillis: 5_000,
            ssl: process.env.PG_SSL === 'true'
                ? { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED !== 'false' }
                : undefined,
        });
        this.pool.on('error', (err) => {
            log.err('Unexpected PG pool error', err);
        });
    }

    async connect(): Promise<void> {
        if (this.migrated) { return; }
        const client = await this.pool.connect();
        try {
            await client.query(DDL);
            this.migrated = true;
            log.info('PostgreSQL connected and schema verified');
        } finally {
            client.release();
        }
    }

    async disconnect(): Promise<void> {
        await this.pool.end();
        log.info('PostgreSQL pool closed');
    }

    async healthCheck(): Promise<boolean> {
        try { await this.pool.query('SELECT 1'); return true; }
        catch { return false; }
    }

    /** Return a collection handle for the given collection name. */
    collection(name: string): PgCollection {
        return new PgCollection(this.pool, name);
    }
}

// ── Helper functions ──────────────────────────────────────────────────────────

function buildConnStr(): string {
    const user = process.env.PG_USER ?? '';
    const pass = process.env.PG_PASS ?? '';
    const host = process.env.PG_HOST ?? 'localhost';
    const port = process.env.PG_PORT ?? '5432';
    const db   = process.env.PG_DB   ?? 'dlms';
    const creds = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : '';
    return `postgresql://${creds}${host}:${port}/${db}`;
}

/**
 * Build a SQL WHERE clause fragment from a plain match object.
 * Supports:
 *   - Simple equality: { field: value }
 *   - Dot-path fields: { 'field.nested': value } → data->>'field'->>'nested'
 *   - $or operator:    { $or: [{ field: val }, ...] }
 *   - MongoDB-style:   { _id: 'xyz' } → id column
 */
function buildWhere(match: any, paramOffset: number = 1): { clause: string; values: any[] } {
    const clauses: string[] = [];
    const values: any[] = [];
    let paramIdx = paramOffset + 1; // $1 is already used for collection

    for (const [key, val] of Object.entries(match)) {
        if (key === '$or' && Array.isArray(val)) {
            const orClauses: string[] = [];
            for (const sub of val as any[]) {
                const { clause, values: subVals } = buildWhere(sub, paramIdx - 1);
                orClauses.push(`(${clause})`);
                values.push(...subVals);
                paramIdx += subVals.length;
            }
            clauses.push(`(${orClauses.join(' OR ')})`);
        } else if (key === '_id' || key === 'id') {
            clauses.push(`id = $${paramIdx++}`);
            values.push(String(val));
        } else if (key.includes('.')) {
            // Dot-path: translate to JSONB path
            const path = key.split('.');
            const jsonPath = path.map((p: string) => `'${p}'`).join('->');
            clauses.push(`(data->${jsonPath}) #>> '{}' = $${paramIdx++}`);
            values.push(String(val));
        } else {
            // Top-level JSONB field equality
            clauses.push(`data->>'${key}' = $${paramIdx++}`);
            values.push(String(val));
        }
    }
    return { clause: clauses.join(' AND ') || 'true', values };
}

function buildSort(sort: any): string {
    if (!sort) { return ''; }
    const parts = [];
    for (const [key, dir] of Object.entries(sort)) {
        const d = Number(dir) === -1 ? 'DESC' : 'ASC';
        if (key === '_id' || key === 'id') {
            parts.push(`id ${d}`);
        } else {
            parts.push(`data->>'${key}' ${d}`);
        }
    }
    return parts.join(', ');
}

function applyProjection(data: any, projection?: any): any {
    if (!projection || !Object.keys(projection).length) { return data; }
    const inclusions = Object.entries(projection).filter(([, v]) => v == 1).map(([k]) => k);
    const exclusions = Object.entries(projection).filter(([, v]) => v == 0).map(([k]) => k);
    if (inclusions.length) {
        const result: any = {};
        for (const k of inclusions) { if (k in data) { result[k] = data[k]; } }
        return result;
    }
    const result = { ...data };
    for (const k of exclusions) { delete result[k]; }
    return result;
}

/** Get a nested field by dot-path (e.g. "comments.0") */
function getNestedField(obj: any, path: string): any {
    const parts = path.split('.');
    let cur = obj;
    for (const p of parts) {
        if (cur == null) { return undefined; }
        cur = cur[p];
    }
    return cur;
}

/** Set a nested field by dot-path (supports "comments.0" style from $set) */
function setNestedField(obj: any, path: string, val: any): void {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (!(p in cur) || typeof cur[p] !== 'object') { cur[p] = {}; }
        cur = cur[p];
    }
    cur[parts[parts.length - 1]] = val;
}

/** Delete a nested field by dot-path */
function deleteNestedField(obj: any, path: string): void {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        if (!(parts[i] in cur)) { return; }
        cur = cur[parts[i]];
    }
    delete cur[parts[parts.length - 1]];
}
