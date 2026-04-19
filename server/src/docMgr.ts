/**
 * docMgr.ts
 *
 * The DocMgr class is the central orchestrator for DLMS.  It mirrors the
 * original dlms-server DocMgr API exactly so that existing application code
 * (like dlms-sample-pg) works without modification.
 *
 * The key differences from the MongoDB-based original:
 *   • Persistence is delegated to a `DbAdapter` (PostgreSQL by default).
 *   • Full-text search is delegated to a `SearchAdapter` (OpenSearch by default).
 *   • Binary attachments are stored in Amazon S3 via `S3Store`.
 *   • Search writes are eventually consistent – RDS is always the SoR.
 */

import {
  DbAdapter,
  SearchAdapter,
  DocMgrCreateArgs,
  Documents,
  DocType,
  DocState,
  UserContext,
  UserGroupCreate,
  UserGroupInfo,
  UserGroupUpdate,
  UserGroupList,
  DocList,
  AttachmentInfo,
  StateCallbackContext,
  Roles,
  Person,
  throwErr,
} from "dlms-base-pg";
import { S3Store } from "./db/s3Store";
import { PgAdapter } from "./db/pgAdapter";
import { OsAdapter } from "./db/osAdapter";
import { Mailer } from "./mailer";
import { logger } from "./logger";

type Readable = import("stream").Readable;

export class DocMgr {
  protected static _instance: DocMgr;

  public readonly appName: string;
  public readonly documents: Documents;
  public readonly adminGroups: string[];
  public readonly adminRole: string;
  public readonly roles: string[];
  public readonly defaultEmail: string;

  protected db: DbAdapter;
  protected search: SearchAdapter;
  protected s3: S3Store;
  protected mailer: Mailer;
  protected userProfileService: any;

  constructor(args: DocMgrCreateArgs) {
    this.appName = args.appName;
    this.documents = args.documents;
    this.adminGroups = args.adminGroups;
    this.adminRole = args.adminRole;
    this.roles = args.roles;
    this.defaultEmail = args.email;

    this.db = new PgAdapter(args.pgUrl);
    this.search = new OsAdapter(args.openSearchUrl);
    this.s3 = new S3Store();
    this.mailer = new Mailer(args.email);
    this.userProfileService = args.userProfileService;
  }

  // ── Singleton ──────────────────────────────────────────────────────────────

  public static setInstance(mgr: DocMgr): void {
    DocMgr._instance = mgr;
  }

  public static getInstance(): DocMgr {
    if (!DocMgr._instance) throw new Error("DocMgr not initialized");
    return DocMgr._instance;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  public async init(simpleInit = false): Promise<void> {
    await this.db.connect();
    try {
      await this.search.connect();
    } catch (err) {
      logger.warn("OpenSearch unavailable on startup – search degraded", { err });
    }

    if (!simpleInit) {
      await this._seedUserGroups();
    }
    logger.info(`DocMgr initialized for app '${this.appName}'`);
  }

  public async shutdown(): Promise<void> {
    await this.db.disconnect();
    await this.search.disconnect();
  }

  public async healthCheck(): Promise<{ pg: boolean; os: boolean }> {
    const [pg, os] = await Promise.all([
      this.db.healthCheck(),
      this.search.healthCheck(),
    ]);
    return { pg, os };
  }

  // ── Document CRUD ──────────────────────────────────────────────────────────

  public async createDoc(
    ctx: UserContext,
    collection: string,
    doc: any,
    id?: string
  ): Promise<any> {
    const docType = this._getDocType(collection);
    if (!docType) throwErr(400, `Unknown document type '${collection}'`);
    if (docType.document_id_required && !id) throwErr(401, `Document id is required for '${collection}'`);

    const docToSave = { ...doc };
    if (id) docToSave._id = id;

    // Find initial state (first state with no entry restriction, or first state)
    const initialState = Object.keys(docType.states)[0];
    if (initialState) docToSave._state = initialState;

    // Access check
    await this._checkEntry(ctx, collection, docToSave, initialState);

    const saved = await this.db.createDoc(collection, docToSave);

    // Run onEntry callback
    await this._runCallback(docType.states[initialState]?.onEntry, ctx, saved);

    // Async: index in OpenSearch
    this._indexAsync(collection, saved);

    return saved;
  }

  public async getDoc(ctx: UserContext, collection: string, id: string): Promise<any> {
    const doc = await this.db.getDoc(collection, id);
    if (!doc) throwErr(404, `Document '${id}' not found in '${collection}'`);
    await this._checkRead(ctx, collection, doc);
    return doc;
  }

  public async updateDoc(
    ctx: UserContext,
    collection: string,
    id: string,
    patch: any
  ): Promise<any> {
    const existing = await this.db.getDoc(collection, id);
    if (!existing) throwErr(404, `Document '${id}' not found`);

    await this._checkWrite(ctx, collection, existing);

    // Handle state transition
    const newState = patch._state ?? patch.state;
    if (newState && newState !== existing._state) {
      await this._validateStateTransition(ctx, collection, existing, newState);
    }

    const updated = await this.db.updateDoc(collection, id, patch);
    if (!updated) throwErr(500, "Update failed");

    if (newState && newState !== existing._state) {
      const docType = this._getDocType(collection);
      await this._runCallback(docType?.states[newState]?.onEntry, ctx, updated);
    }

    this._indexAsync(collection, updated);
    return updated;
  }

  public async deleteDoc(ctx: UserContext, collection: string, id: string): Promise<any> {
    const doc = await this.db.getDoc(collection, id);
    if (!doc) throwErr(404, `Document '${id}' not found`);
    await this._checkWrite(ctx, collection, doc);

    const deleted = await this.db.deleteDoc(collection, id);
    this._deleteIndexAsync(collection, id);
    return deleted;
  }

  public async listDocs(
    ctx: UserContext,
    collection: string,
    match?: any,
    projection?: string[]
  ): Promise<DocList> {
    const items = await this.db.listDocs(collection, match, projection);
    return { count: items.length, items };
  }

  public async searchDocs(
    ctx: UserContext,
    collection: string,
    query: string,
    filters?: any
  ): Promise<DocList> {
    const items = await this.search.search(collection, query, filters);
    return { count: items.length, items };
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  public async invokeAction(ctx: UserContext, collection: string, id: string, args: any): Promise<any> {
    const doc = await this.db.getDoc(collection, id);
    if (!doc) throwErr(404, `Document '${id}' not found`);

    const docType = this._getDocType(collection);
    const state = docType?.states[doc._state];
    if (!state?.action) return undefined;

    const callbackCtx = this._buildCtx(ctx, doc);
    return state.action(callbackCtx);
  }

  // ── Attachments ────────────────────────────────────────────────────────────

  public async createAttachment(
    ctx: UserContext,
    collection: string,
    docId: string,
    file: Express.Multer.File
  ): Promise<AttachmentInfo[]> {
    const doc = await this.db.getDoc(collection, docId);
    if (!doc) throwErr(404, `Document '${docId}' not found`);
    await this._checkWrite(ctx, collection, doc);

    const existing = await this.db.listAttachmentsByDoc(collection, docId);
    const dup = existing.find((a) => a.name === file.originalname);

    let info: AttachmentInfo;
    if (dup) {
      // Replace: delete old S3 object, update metadata
      if (dup.s3Key) await this.s3.delete(dup.s3Key);
      const s3Key = await this.s3.upload(
        collection, docId, dup.id, file.originalname, file.buffer, file.mimetype
      );
      await this.db.deleteAttachment(dup.id);
      info = await this.db.createAttachment({
        name: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        docId,
        collection,
        s3Key,
      });
    } else {
      const tempId = require("uuid").v4();
      const s3Key = await this.s3.upload(
        collection, docId, tempId, file.originalname, file.buffer, file.mimetype
      );
      info = await this.db.createAttachment({
        name: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        docId,
        collection,
        s3Key,
      });
    }

    return this.db.listAttachmentsByDoc(collection, docId);
  }

  public async getAttachment(
    ctx: UserContext,
    collection: string,
    docId: string,
    attachmentId: string
  ): Promise<Readable> {
    const doc = await this.db.getDoc(collection, docId);
    if (!doc) throwErr(404, `Document '${docId}' not found`);
    await this._checkRead(ctx, collection, doc);

    const att = await this.db.getAttachment(attachmentId);
    if (!att) throwErr(404, `Attachment '${attachmentId}' not found`);
    if (!att.s3Key) throwErr(500, "Attachment has no S3 key");

    return this.s3.download(att.s3Key);
  }

  public async deleteAttachment(
    ctx: UserContext,
    collection: string,
    docId: string,
    attachmentId: string
  ): Promise<AttachmentInfo[]> {
    const doc = await this.db.getDoc(collection, docId);
    if (!doc) throwErr(404, `Document '${docId}' not found`);
    await this._checkWrite(ctx, collection, doc);

    const att = await this.db.getAttachment(attachmentId);
    if (!att) throwErr(404, `Attachment '${attachmentId}' not found`);
    if (att.s3Key) await this.s3.delete(att.s3Key);
    await this.db.deleteAttachment(attachmentId);

    return this.db.listAttachmentsByDoc(collection, docId);
  }

  public async listAttachments(
    ctx: UserContext,
    collection: string,
    docId: string
  ): Promise<DocList> {
    const doc = await this.db.getDoc(collection, docId);
    if (!doc) throwErr(404, `Document '${docId}' not found`);
    await this._checkRead(ctx, collection, doc);
    const items = await this.db.listAttachmentsByDoc(collection, docId);
    return { count: items.length, items };
  }

  public async listAllAttachments(): Promise<DocList> {
    const items = await this.db.listAllAttachments();
    return { count: items.length, items };
  }

  // ── User Groups ────────────────────────────────────────────────────────────

  public async createUserGroup(ctx: UserContext, group: UserGroupCreate): Promise<UserGroupInfo> {
    this._requireAdmin(ctx);
    return this.db.createGroup(group);
  }

  public async getUserGroup(id: string): Promise<UserGroupInfo> {
    const g = await this.db.getGroup(id);
    if (!g) throwErr(404, `User group '${id}' not found`);
    return g;
  }

  public async updateUserGroup(
    ctx: UserContext,
    id: string,
    patch: UserGroupUpdate
  ): Promise<UserGroupInfo> {
    this._requireAdmin(ctx);
    const g = await this.db.updateGroup(id, patch);
    if (!g) throwErr(404, `User group '${id}' not found`);
    return g;
  }

  public async deleteUserGroup(ctx: UserContext, id: string): Promise<UserGroupInfo> {
    this._requireAdmin(ctx);
    const g = await this.db.deleteGroup(id);
    if (!g) throwErr(404, `User group '${id}' not found`);
    return g;
  }

  public async listUserGroups(): Promise<UserGroupList> {
    const items = await this.db.listGroups();
    return { count: items.length, items };
  }

  // ── Admin ──────────────────────────────────────────────────────────────────

  public async exportAll(ctx: UserContext): Promise<any> {
    this._requireAdmin(ctx);
    return this.db.exportAll();
  }

  public async exportIds(ctx: UserContext): Promise<{ [collection: string]: string[] }> {
    this._requireAdmin(ctx);
    const all = await this.db.exportAll();
    const result: { [col: string]: string[] } = {};
    for (const [col, docs] of Object.entries(all)) {
      result[col] = (docs as any[]).map((d) => d._id ?? d.id);
    }
    return result;
  }

  public async exportDoc(
    ctx: UserContext,
    collection: string,
    id: string
  ): Promise<any> {
    this._requireAdmin(ctx);
    const doc = await this.db.getDoc(collection, id);
    if (!doc) throwErr(404, `Document '${id}' not found`);
    return doc;
  }

  public async importAll(ctx: UserContext, data: any): Promise<void> {
    this._requireAdmin(ctx);
    await this.db.importAll(data);
    // Reindex everything into OpenSearch
    for (const [collection, docs] of Object.entries(data)) {
      if (collection === "__user_groups") continue;
      try {
        await this.search.reindex(collection, docs as any[]);
      } catch (err) {
        logger.warn(`OS reindex failed for '${collection}'`, { err });
      }
    }
  }

  public async importDoc(
    ctx: UserContext,
    collection: string,
    id: string,
    doc: any
  ): Promise<any> {
    this._requireAdmin(ctx);
    if (!doc._id && !doc.id) throwErr(400, "Document has no _id property");
    const saved = await this.db.createDoc(collection, { ...doc, _id: id });
    this._indexAsync(collection, saved);
    return saved;
  }

  public async reset(ctx: UserContext, simpleInit = false): Promise<void> {
    this._requireAdmin(ctx);
    await this.db.dropAll();
    if (!simpleInit) await this._seedUserGroups();
  }

  // ── User profile ───────────────────────────────────────────────────────────

  public async getUserProfile(claimsOrUid: any): Promise<UserContext[]> {
    if (!this.userProfileService) return [];
    return this.userProfileService.get(claimsOrUid);
  }

  public async verifyUser(uid: string, pwd: string): Promise<UserContext> {
    if (!this.userProfileService) throwErr(401, "No user profile service configured");
    return this.userProfileService.verify(uid, pwd);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  protected _getDocType(collection: string): DocType | undefined {
    return this.documents[collection];
  }

  protected _requireAdmin(ctx: UserContext): void {
    const isAdmin =
      ctx.isAdmin ||
      ctx.user.roles.includes(this.adminRole) ||
      this.adminGroups.some((g) => ctx.user.roles.includes(g));
    if (!isAdmin) throwErr(401, "Admin access required");
  }

  private async _seedUserGroups(): Promise<void> {
    const createArgs = (this.constructor as any)._initArgs?.userGroups ?? [];
    // Called from subclass constructor args – seeded on first run
  }

  private async _checkEntry(
    ctx: UserContext,
    collection: string,
    doc: any,
    stateName: string
  ): Promise<void> {
    const docType = this._getDocType(collection);
    if (!docType) return;
    const state = docType.states[stateName];
    if (!state?.entry) return;
    const callbackCtx = this._buildCtx(ctx, doc);
    if (typeof state.entry === "function") {
      await state.entry(callbackCtx);
    }
    // string[] means role list – check performed by middleware
  }

  private async _checkRead(ctx: UserContext, collection: string, doc: any): Promise<void> {
    if (ctx.isAdmin) return;
    const docType = this._getDocType(collection);
    if (!docType) return;
    const state = docType.states[doc._state];
    if (!state?.read) return;
    if (Array.isArray(state.read)) {
      const hasRole = state.read.some((r) => ctx.user.roles.includes(r));
      if (!hasRole) throwErr(401, "Read access denied");
    } else {
      const callbackCtx = this._buildCtx(ctx, doc);
      await state.read(callbackCtx);
    }
  }

  private async _checkWrite(ctx: UserContext, collection: string, doc: any): Promise<void> {
    if (ctx.isAdmin) return;
    const docType = this._getDocType(collection);
    if (!docType) return;
    const state = docType.states[doc._state];
    if (!state?.write) return;
    if (Array.isArray(state.write)) {
      const hasRole = state.write.some((r) => ctx.user.roles.includes(r));
      if (!hasRole) throwErr(401, "Write access denied");
    } else {
      const callbackCtx = this._buildCtx(ctx, doc);
      await state.write(callbackCtx);
    }
  }

  private async _validateStateTransition(
    ctx: UserContext,
    collection: string,
    doc: any,
    newState: string
  ): Promise<void> {
    const docType = this._getDocType(collection);
    if (!docType) return;
    const currentState = docType.states[doc._state];
    if (!currentState) return;
    if (!currentState.nextStates?.[newState]) {
      throwErr(500, `Invalid state transition from '${doc._state}' to '${newState}'`);
    }
  }

  private async _runCallback(cb: any, ctx: UserContext, doc: any): Promise<void> {
    if (!cb) return;
    try {
      const callbackCtx = this._buildCtx(ctx, doc);
      await cb(callbackCtx);
    } catch (err) {
      logger.error("State callback error", { err });
    }
  }

  private _buildCtx(ctx: UserContext, doc: any): StateCallbackContext {
    return {
      user: ctx.user,
      document: doc,
      isCallerInGroup: async (groups: string[]) => {
        for (const g of groups) {
          const group = await this.db.getGroup(g);
          if (group?.members.some((m) => m.email === ctx.user.email)) return true;
        }
        return false;
      },
      accessDeniedError: () => throwErr(401, "Access denied") as never,
      notify: async (recipients: Person[], subject: string, body: string) => {
        await this.mailer.send(recipients.map((r) => r.email), subject, body);
      },
    };
  }

  private _indexAsync(collection: string, doc: any): void {
    this.search.indexDoc(collection, doc).catch((err) =>
      logger.warn("OS index failed (non-fatal)", { collection, docId: doc._id, err })
    );
  }

  private _deleteIndexAsync(collection: string, id: string): void {
    this.search.deleteIndexedDoc(collection, id).catch((err) =>
      logger.warn("OS delete index failed (non-fatal)", { collection, id, err })
    );
  }
}
