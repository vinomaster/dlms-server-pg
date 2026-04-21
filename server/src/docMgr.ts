/**
 * Copyright (c) 2024 Discover Financial Services
 *
 * Polyglot edition: MongoDB persistence replaced with PostgreSQL (via PgAdapter).
 * All business logic, ACL checks, state machine, comments, email notifications,
 * streaming, iterator support, and the full DocMgr/StateCallbackContextImpl API
 * are preserved verbatim from the original dlms-server.
 *
 * The only changes from the original are:
 *   1. `import mongoose / mongodb` → removed; replaced with `import { PgAdapter }`
 *   2. `protected mongoUrl / getMongoUrl()` → replaced with pgUrl / getPgUrl()
 *   3. `getConnection() / getCollection() / getDocCollection()` → delegate to PgAdapter
 *   4. Inline MongoDB collection calls (insertOne, findOne, updateOne, etc.)
 *      inside _createDoc / _getDoc / getDocs / updateDoc / deleteDoc / deleteMany
 *      / user group methods / attachment methods / export / import / reset
 *      → replaced with PgAdapter method calls
 *   5. `lz-ts` compress / ObjectId → removed (streaming & aggregates kept via PgAdapter)
 *   6. DocMgrCreateArgs: `mongoUrl?` → `pgUrl?`  (backwards-compatible: old mongoUrl ignored)
 *
 * Everything else — including the full comment system, streaming iterator cache,
 * sendNotifications, emailComments, toMongoUpdate (renamed toDbUpdate), etc. — is
 * kept unchanged.
 */
import express from 'express';
import nodemailer from 'nodemailer';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from './logger';
import { Config } from './config';
import { getField, sleep, throwErr } from './util';
import {
    DefaultUserProfileService,
    UserProfileService,
} from './userProfileService';
import {
    UserContext,
    UserGroupInfo,
    UserGroupCreate,
    UserGroupUpdate,
    UserGroupList,
    DocState,
    Person,
    PersonWithId,
    StateCallback,
    StateCallbackContext,
    DocInfo,
    Roles,
    EmailAttachment,
    CommentCreate,
    CommentInfo,
    CommentUpdate,
    AttachmentModel,
    StateHistory,
    formatDateTime,
} from 'dlms-base';
import { PgAdapter } from './db/pgAdapter';
export * from 'dlms-base';

const log = new Logger('dlms-docMgr');
const config = new Config();

const adminIds: string[] = process.env.IDS_ADMIN
    ? process.env.IDS_ADMIN.split(',')
    : [];

const emailEnabled = process.env.EMAIL_ENABLED === 'true';

export interface Metadata {
    version: number;
    last: boolean;
}

export interface PostDocs {
    stream?: string;
    params?: {
        match?: any;
        options?: {
            sort?: any;
            projection?: any;
            limit?: number;
        };
        projection?: any;
    };
}

export interface Document extends DocType {}
export interface DocType {
    states: {
        [name: string]: DocState;
    };
    collectionName?: string;
    docRoles?: Roles;
    document_id_required?: boolean;
    defaultProjection?: any;
    modifyProjection?: (type: string, queryProjection: any) => any;
    toInfo?: (type: string, doc: any, copy: boolean) => any;
    toSummary?: (type: string, doc: any, originalProjection: any, copy: boolean) => any;
    includeStateHistory?: boolean;
    includeDateCreated?: boolean;
    includeDateUpdated?: boolean;
    includeComments?: boolean;
    commentKeyWords?: any;
    includeOwner?: boolean;
    createdState?: string;
    onCreate?: (docMgr: DocMgr, ctx: UserContext, type: string, doc: any) => Promise<any>;
    onPostCreate?: (docMgr: DocMgr, ctx: UserContext, type: string, doc: any) => Promise<any>;
    extraCreateArgs?: any;
    onUpdate?: (docMgr: DocMgr, ctx: UserContext, ds: DocSpec, doc: any) => Promise<any>;
    onPostUpdate?: (docMgr: DocMgr, ctx: UserContext, type: string, doc: any) => Promise<any>;
    onDelete?: (docMgr: DocMgr, ctx: UserContext, type: string, doc: any) => Promise<any>;
    onPostDelete?: (docMgr: DocMgr, ctx: UserContext, type: string, doc: any) => Promise<any>;
    globalReadAccess?: boolean;
    validate?: Validate;
}

export interface Validate {
    createDoc?: (type: string, body: any) => any;
    createDocById?: (type: string, id: string, body: any) => any;
    postDocs?: (type: string, body: any) => any;
    getDocs?: (type: string, match: any, options: any, stream?: string) => any;
    getDoc?: (type: string, id: string) => any;
    updateDoc?: (type: string, id: string, args: any) => any;
    deleteMany?: (type: string, match: any, preview?: boolean) => any;
    deleteDoc?: (type: string, id: string) => any;
    addComment?: (type: string, id: string, args: any) => any;
    getComment?: (type: string, id: string, cid: string) => any;
    updateComment?: (type: string, id: string, cid: string, args: any) => any;
    deleteComment?: (type: string, id: string, cid: string) => any;
    [name: string]: any;
}

export interface Documents {
    [name: string]: DocType;
}

export interface DocSpec {
    type: string;
    id: string;
    version?: string;
}

export interface DocMgrCreateArgs {
    appName: string;
    documents: Documents;
    userGroups: UserGroupCreate[];
    adminGroups: string[];
    adminRole: string;
    managerRole?: string;
    roles: string[];
    email: string;
    /** Polyglot: PostgreSQL connection URL (replaces mongoUrl) */
    pgUrl?: string;
    /** Legacy: ignored in polyglot edition */
    mongoUrl?: string;
    userProfileService?: UserProfileService;
    enableUtf8Validation?: boolean;
}

interface UserGroupCacheEntry {
    [id: string]: UserGroupInfo;
}

export class DocMgr {
    private static instance: DocMgr | undefined;

    public static setInstance(instance: DocMgr) {
        if (DocMgr.instance) {
            return throwErr(500, `DocMgr.setInstance has already been called`);
        }
        DocMgr.instance = instance;
    }

    public static getInstance(): DocMgr {
        if (!DocMgr.instance) {
            return throwErr(500, `DocMgr.setInstance has not been called`);
        }
        return DocMgr.instance;
    }

    protected appName: string;
    protected documents: Documents;
    protected email: string;
    protected userCollectionName: string;
    protected attachmentCollectionName: string;
    protected allCollectionNames: string[];
    protected transporter: nodemailer.Transporter;
    protected adminCtx: UserContext;
    protected userGroups: UserGroupCreate[];
    protected adminGroups: string[];
    protected adminRole: string;
    protected managerRole: string;
    protected roles: string[];
    protected userGroupCache: UserGroupCacheEntry;
    protected connected = false;
    protected initialized = false;
    protected simpleInit: boolean | undefined;
    protected userProfileService: UserProfileService;
    protected enableUtf8Validation = false;
    protected drainTimeout = parseInt('' + process.env['DRAIN_TIMEOUT']) || 60000;
    protected iteratorCache: { [id: string]: any } = {};

    /** PostgreSQL adapter — replaces mongoose connection */
    protected db: PgAdapter;

    constructor(args: DocMgrCreateArgs) {
        log.debug(`DLMS Server v2 (Polyglot/PostgreSQL edition)`);
        this.appName = args.appName;
        this.documents = args.documents;
        this.email = args.email;
        this.userCollectionName = `${this.appName}.user`;
        this.attachmentCollectionName = `${this.appName}.attachment`;
        const cNames = [this.userCollectionName, this.attachmentCollectionName];
        this.allCollectionNames = cNames.concat(
            Object.keys(args.documents).map(key => this.getDocCollectionName(key))
        );
        this.transporter = nodemailer.createTransport({
            host: config.emailServer,
            port: 25,
            tls: { rejectUnauthorized: false },
        });
        this.adminCtx = {
            user: {
                id: 'docMgr',
                name: 'DocMgr',
                roles: ['Admin'],
                email: 'DLMSServer',
                title: 'Admin',
                employeeNumber: 'none',
                department: 'none',
            },
        };
        this.userGroups = args.userGroups;
        this.adminGroups = args.adminGroups;
        this.adminRole = args.adminRole;
        this.managerRole = args.managerRole || '';
        this.roles = args.roles;
        this.userGroupCache = {};
        this.userProfileService =
            args.userProfileService || new DefaultUserProfileService();

        // Initialise the PostgreSQL adapter
        this.db = new PgAdapter(args.pgUrl);
    }

    public getUserProfileService(): UserProfileService {
        return this.userProfileService;
    }

    public getAdminRole(): string {
        return this.adminRole;
    }

    public getMgrRole(): string {
        return this.managerRole;
    }

    /* eslint-disable @typescript-eslint/no-unused-vars */
    public async getRoles(ctx: UserContext): Promise<string[]> {
        return this.roles;
    }
    /* eslint-enable @typescript-eslint/no-unused-vars */

    public async getDocRoles(ctx: UserContext, type?: string): Promise<Roles> {
        if (type) {
            return this.documents[type]?.docRoles || {};
        }
        return {};
    }

    public getAppName() {
        return this.appName;
    }

    public getAllCollectionNames() {
        return this.allCollectionNames;
    }

    public getAdminContext() {
        return this.adminCtx;
    }

    private initHasBeenCalled = false;

    public async init(simpleInit?: boolean) {
        if (this.initialized) {
            return;
        }
        if (!this.initHasBeenCalled) {
            this.simpleInit = simpleInit;
        }
        // Connect PostgreSQL on first init
        if (!this.connected) {
            await this.db.connect();
            this.connected = true;
        }
        try {
            const ctx = this.adminCtx;
            if (!this.simpleInit) {
                for (const ug of this.userGroups) {
                    await this.getOrCreateUserGroup(ctx, {
                        id: ug.id,
                        deletable: ug.deletable,
                    });
                }
            }
            this.initialized = true;
        } catch (e: any) {
            log.err(`Failed to initialize database: ${e.message}`);
        }
        if (!this.initHasBeenCalled) {
            this.initHasBeenCalled = true;
            await this.onInit();
        }
    }

    public async onInit() {}

    public allowCrossDomain(_req: express.Request, res: express.Response, next: express.NextFunction) {
        let authRequest = false;
        if (_req.headers?.['access-control-request-headers']?.includes('authorization') || _req.headers?.authorization) {
            authRequest = true;
        }
        const originHeader = _req.headers?.origin || config.corsOrigin;
        res.header('Access-Control-Allow-Origin', originHeader);
        res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,PATCH');
        res.header('Access-Control-Request-Headers', '*');
        if (authRequest) {
            res.header('Access-Control-Allow-Headers', 'authorization,content-type,no-auth-user');
            res.header('Access-Control-Allow-Credentials', 'true');
            res.header('Access-Control-Expose-Headers', 'content-type,no-auth-user');
        } else {
            res.header('Access-Control-Allow-Headers', '*');
            res.header('Access-Control-Expose-Headers', '*');
        }
        next();
    }

    // ── Document CRUD ─────────────────────────────────────────────────────────

    public async createDoc(ctx: UserContext, type: string, doc: any): Promise<any> {
        const dt = this.getDocType(type);
        if (dt.document_id_required) {
            return throwErr(401, `documents of type '${type}' require the ID to be specified by the caller`);
        }
        delete doc._id;
        delete doc.id;
        return await this._createDoc(ctx, type, doc);
    }

    public async createDocById(ctx: UserContext, type: string, id: string, doc: any): Promise<any> {
        const dt = this.getDocType(type);
        if (!dt.document_id_required) {
            return throwErr(401, `documents of type '${type}' may not be created with an ID that is specified by the caller`);
        }
        doc._id = id;
        return await this._createDoc(ctx, type, doc);
    }

    protected async _createDoc(ctx: UserContext, type: string, doc: any): Promise<any> {
        log.debug(`Creating document of type ${type}`);
        ctx.mode = 'create';
        const docType = this.getDocType(type);
        if (!doc.state && docType.createdState) {
            doc.state = docType.createdState;
        }
        await this.assertEntryAccess(ctx, type, doc);
        const now = Date.now();
        const docState = await this.getDocState(ctx, type, doc.state);
        if (docState.onEntry) {
            await docState.onEntry(new StateCallbackContextImpl(ctx, this, type, this.toInfo(doc, true)));
        }
        if (docType.includeDateCreated) { doc.dateCreated = now; }
        if (docType.includeDateUpdated) { doc.dateUpdated = now; }
        if (docType.includeStateHistory) {
            doc.stateHistory = [{ state: doc.state || docType.createdState || 'created', date: now, email: ctx.user.email }];
        }
        if (docType.includeComments) { doc.comments = []; }
        if (docType.includeOwner) { doc.owner = ctx.user; }
        if (docType.extraCreateArgs) { doc = { ...doc, ...docType.extraCreateArgs }; }
        if (docType.onCreate) {
            const r = await docType.onCreate(this, ctx, type, this.toInfo(doc, true));
            if (r) { doc = r; }
        }
        doc.curStateRead = (await this.getInUserGroups(ctx, docState.read, type, doc)) || [];
        doc.curStateWrite = (await this.getInUserGroups(ctx, docState.write, type, doc)) || [];

        // ── PostgreSQL insert ──────────────────────────────────────────────────
        const pc = await this.getDocCollection(type);
        const id = await pc.insertOne(doc);
        doc._id = id;
        log.debug(`Created document of type ${type} with id ${id}, getting doc`);
        const rtn = await this._getDoc(ctx, { type, id });
        log.debug(`Got doc of type ${type} with id ${id}`);

        if (docType.onPostCreate) {
            const r = await docType.onPostCreate(this, ctx, type, this.toInfo(doc, true));
            if (r) { return r; }
        }
        return rtn;
    }

    public async getDoc(ctx: UserContext, ds: DocSpec, projection?: any): Promise<any> {
        ctx.docId = ds.id;
        ctx.mode = 'read';
        const doc = await this._getDoc(ctx, ds);
        await this.assertReadAccess(ctx, ds.type, doc);
        const docState = await this.getDocState(ctx, ds.type, doc.state);
        if (docState.onRead) {
            await docState.onRead(new StateCallbackContextImpl(ctx, this, ds.type, this.toInfo(doc, true)));
        }
        const r = (!projection) ? doc : await this._getDoc(ctx, ds, projection);
        const docType = this.getDocType(ds.type);
        if (docType.includeComments && r.comments) {
            const comments = [];
            for (var c of r.comments) {
                if (await this.canViewComment(ctx, ds, c)) {
                    comments.push(c);
                }
            }
            r.comments = comments;
        } else {
            delete r.comments;
        }
        if (docState.onAfterRead) {
            await docState.onAfterRead(new StateCallbackContextImpl(ctx, this, ds.type, this.toInfo(doc, true)));
        }
        return r;
    }

    public async runActionForDoc(ctx: UserContext, ds: DocSpec, args: any): Promise<any> {
        if (ds.id == 'none') {
            const doc = this.getDocType(ds.type);
            const stateNames = Object.keys(doc.states);
            const docState = doc.states[stateNames[0]];
            ctx.updates = args;
            if (docState.action) {
                return await docState.action(new StateCallbackContextImpl(ctx, this, ds.type, {}));
            }
        } else {
            const doc = await this.getDoc(ctx, ds);
            const docState = await this.getDocState(ctx, ds.type, doc.state);
            if (docState.action) {
                ctx.updates = args;
                return await docState.action(new StateCallbackContextImpl(ctx, this, ds.type, this.toInfo(doc, true)));
            }
        }
    }

    protected async _getDoc(ctx: UserContext, ds: DocSpec, project?: any): Promise<any> {
        log.debug(`Getting doc: ${JSON.stringify(ds)}`);
        const pc = await this.getDocCollection(ds.type);
        const doc: any = await pc.findOne(ds.id, project);
        if (!doc) {
            return throwErr(404, `document '${JSON.stringify(ds)}' was not found`);
        }
        return this.toInfo(doc, false);
    }

    public getDocType(type: string): DocType {
        if (!(type in this.documents)) {
            return throwErr(400, `Invalid document type: '${type}'`);
        }
        return this.documents[type];
    }

    public async getDocState(ctx: UserContext, type: string, state?: string): Promise<DocState> {
        const doc = this.getDocType(type);
        if (state !== undefined) {
            state = state.split('$')[0];
            if (!(state in doc.states)) {
                const admin = await this.isAdmin(ctx);
                if (admin) {
                    log.err(`Invalid state in '${type}' document: '${state}' - allow to continue since user is admin`);
                    return { label: 'invalid', description: '', nextStates: {} };
                }
                return throwErr(400, `Invalid state in '${type}' document: '${state}'`);
            }
            return doc.states[state];
        } else {
            const stateNames = Object.keys(doc.states);
            if (stateNames.length !== 1) {
                return throwErr(400, `Document of type '${type}' can have multiple states but it is missing a 'state' field`);
            }
            return doc.states[stateNames[0]];
        }
    }

    public convertRegex(parent: any, key: any, obj: any) {
        if (typeof obj === 'string') {
            if (obj.charAt(0) == '/') {
                let i = obj.lastIndexOf('/');
                let exp = obj.substring(1, i);
                let opt = obj.substring(i + 1);
                parent[key] = new RegExp(exp, opt);
            }
        } else {
            if (obj !== null && typeof obj === 'object') {
                if (Array.isArray(obj)) {
                    for (const i in obj) { this.convertRegex(obj, i, obj[i]); }
                } else {
                    for (const r in obj) { this.convertRegex(obj, r, obj[r]); }
                }
            }
        }
    }

    public async getDocs(
        ctx: UserContext,
        type: string,
        match?: any,
        options?: any,
        streamOrIterator?: string,
        response?: any,
        processDoc?: (doc: any) => Promise<any>
    ): Promise<any> {
        log.debug('getDocs: type=', type, 'match=', match, 'options=', options, 'streamOrIterator=', streamOrIterator);
        const pc = await this.getDocCollection(type);

        if (typeof match === 'string') {
            match = JSON.parse(match);
            this.convertRegex(null, null, match);
        }
        if (!options) { options = {}; }
        if (typeof options.projection === 'string') {
            options.projection = JSON.parse(options.projection);
        }

        const docType = this.getDocType(type);
        if (!options.projection && docType.defaultProjection) {
            options.projection = { ...docType.defaultProjection };
        }

        let _match: any = {};
        if (typeof match === 'string') { _match = JSON.parse(match); }
        else if (match) { _match = match; }

        if (!options) { options = { projection: {} }; }
        if (typeof options.projection === 'string') {
            options.projection = JSON.parse(options.projection);
        }
        let _projection: any = {};
        if (typeof options.projection === 'string') { _projection = JSON.parse(options.projection); }
        else { _projection = options.projection; }

        let removeId = false;
        if (_projection) {
            for (const field of Object.keys(_projection)) {
                if (_projection[field] == 1) {
                    if (!_projection['id']) { removeId = true; }
                    break;
                } else if (_projection[field] == 0) {
                    if (_projection.hasOwnProperty('id')) { removeId = true; }
                }
            }
        }

        let original_projection = _projection ? JSON.parse(JSON.stringify(_projection)) : undefined;
        if (docType.modifyProjection) { docType.modifyProjection(type, _projection); }
        options.projection = _projection;

        // ── PostgreSQL find ────────────────────────────────────────────────────
        const start = Date.now();
        const docs = await pc.find(_match, options);
        log.debug(`Time for ${type} query = ${((Date.now() - start) / 1000)} seconds`);
        log.debug(`Searched for ${type} and found ${docs.length} documents`);

        // Iterator / streaming support
        if (streamOrIterator === 'iterator') {
            const iteratorId = uuidv4();
            this.iteratorCache[iteratorId] = {
                results: 'query',
                docs: docs,
                index: 0,
                type: type,
                original_projection: original_projection,
                removeId: removeId,
                processDoc: processDoc,
                dateCreated: Date.now(),
            };
            log.debug(`Created iterator id=${iteratorId}`);
            return iteratorId;
        }

        if (streamOrIterator && response) {
            return await this.streamQueryResults(ctx, type, docs, streamOrIterator, response, original_projection, removeId, processDoc);
        }

        const rtn: any = [];
        for (let doc of docs) {
            if (removeId) {
                delete doc.id;
                delete doc._id;
                ctx.docId = undefined;
            } else {
                doc = this.toInfo(doc, false);
                ctx.docId = doc.id;
            }
            ctx.mode = 'read';
            try {
                let allowAccess = true;
                if (!docType.globalReadAccess) {
                    allowAccess = await this.hasReadAccess(ctx, type, doc);
                }
                if (allowAccess) {
                    if (docType.toSummary) {
                        rtn.push(docType.toSummary(type, doc, original_projection, false));
                    } else {
                        rtn.push(this.toGenericSummary(type, doc, original_projection, false));
                    }
                    if (doc.state) {
                        const docState = await this.getDocState(ctx, type, doc.state);
                        if (docState.onRead) {
                            await docState.onRead(new StateCallbackContextImpl(ctx, this, type, this.toInfo(doc, true)));
                        }
                    }
                }
            } catch (e) {
                log.debug('Error getting doc: ', e);
                return docs;
            }
        }
        return rtn;
    }

    public getIterators() {
        return this.iteratorCache;
    }

    public async getNextDoc(ctx: UserContext, iteratorId: string, count?: number) {
        const numDocs = count || 1;
        if (numDocs == 1) { return await this._getNextDoc(ctx, iteratorId); }
        const docs: any[] = [];
        for (let i = 0; i < numDocs; i++) {
            const doc = await this._getNextDoc(ctx, iteratorId);
            if (doc) { docs.push(doc); } else { break; }
        }
        return docs.length == 0 ? null : docs;
    }

    protected async _getNextDoc(ctx: UserContext, iteratorId: string) {
        const iterator = this.iteratorCache[iteratorId];
        if (!iterator) { return null; }
        const { docs, type, original_projection, removeId, processDoc } = iterator;
        const docType = type ? this.getDocType(type) : null;

        if (iterator.index >= docs.length) {
            delete this.iteratorCache[iteratorId];
            return null;
        }

        let doc = docs[iterator.index++];
        if (removeId) {
            delete doc.id;
            delete doc._id;
            ctx.docId = undefined;
        } else {
            doc = this.toInfo(doc, false);
            ctx.docId = doc.id;
        }
        ctx.mode = 'read';
        try {
            let allowAccess = true;
            if (type && docType && !docType.globalReadAccess) {
                allowAccess = await this.hasReadAccess(ctx, type, doc);
            }
            if (allowAccess) {
                if (type && docType?.toSummary) {
                    doc = docType.toSummary(type, doc, original_projection, false);
                } else {
                    doc = this.toGenericSummary(type, doc, original_projection, false);
                }
                if (type && doc.state) {
                    const docState = await this.getDocState(ctx, type, doc.state);
                    if (docState.onRead) {
                        await docState.onRead(new StateCallbackContextImpl(ctx, this, type, this.toInfo(doc, true)));
                    }
                }
                if (processDoc) { doc = await processDoc(doc); }
                return doc;
            }
        } catch (e) {
            log.debug('Error getting doc: ', e);
            return throwErr(400, `Error getting doc from iterator=${e}`);
        }
    }

    /** Stream array of docs (from PgAdapter) to HTTP response */
    public async streamQueryResults(
        ctx: any,
        type: string | null,
        docs: any[],
        stream: string,
        response: any,
        original_projection: any,
        removeId: boolean,
        processDoc?: any
    ) {
        log.debug(`Streaming ${type} query results (${docs.length} docs)...`);
        const docType = type ? this.getDocType(type) : null;
        let count = 0;
        let pause = 0;

        for (let doc of docs) {
            if (removeId) {
                delete doc.id;
                delete doc._id;
                ctx.docId = undefined;
            } else {
                doc = this.toInfo(doc, false);
                ctx.docId = doc.id;
            }
            ctx.mode = 'read';
            try {
                let allowAccess = true;
                if (type && docType && !docType.globalReadAccess) {
                    allowAccess = await this.hasReadAccess(ctx, type, doc);
                }
                if (allowAccess) {
                    if (type && docType?.toSummary) {
                        doc = docType.toSummary(type, doc, original_projection, false);
                    } else {
                        doc = this.toGenericSummary(type, doc, original_projection, false);
                    }
                    if (type && doc.state) {
                        const docState = await this.getDocState(ctx, type, doc.state);
                        if (docState.onRead) {
                            await docState.onRead(new StateCallbackContextImpl(ctx, this, type, this.toInfo(doc, true)));
                        }
                    }
                    if (processDoc) { doc = await processDoc(doc); }
                    const data1 = JSON.stringify(doc);
                    response.write((''+data1.length).padStart(16, '0'));
                    const r = response.write(data1);
                    if (!r) {
                        pause = 10;
                        response.once('drain', () => { pause = 0; });
                    }
                    while (pause) {
                        pause += 10;
                        if (pause > this.drainTimeout) {
                            response.status(500);
                            return response.end();
                        }
                        await sleep(10);
                    }
                }
            } catch (e) {
                log.debug('Error getting doc: ', e);
            }
            count++;
        }
        response.write(''.padStart(16, '-'));
        response.end();
        return count;
    }

    public toGenericSummary(type: string | null, doc: any, projection: any, copy: boolean): any {
        if (copy) { doc = JSON.parse(JSON.stringify(doc)); }
        return doc;
    }

    // ── Access control ────────────────────────────────────────────────────────

    public async assertEntryAccess(ctx: UserContext, type: string, doc: any) {
        if (!(await this.hasEntryAccess(ctx, type, doc))) { throwErr(401, 'entry access denied'); }
    }

    public async assertReadAccess(ctx: UserContext, type: string, doc: any) {
        if (!(await this.hasReadAccess(ctx, type, doc))) { throwErr(401, 'read access denied'); }
    }

    public async assertWriteAccess(ctx: UserContext, type: string, doc: any) {
        if (!(await this.hasWriteAccess(ctx, type, doc))) { throwErr(401, 'write access denied'); }
    }

    public async assertDeleteAccess(ctx: UserContext, type: string, doc: any) {
        if (!(await this.hasDeleteAccess(ctx, type, doc))) { throwErr(401, 'delete access denied'); }
    }

    public async hasEntryAccess(ctx: UserContext, type: string, doc: any): Promise<boolean> {
        const docState = await this.getDocState(ctx, type, doc.state);
        try { await this.assertInUserGroups(ctx, docState.entry, type, doc); } catch (e) { return false; }
        return true;
    }

    public async hasReadAccess(ctx: UserContext, type: string, doc: any): Promise<boolean> {
        const docState = await this.getDocState(ctx, type, doc.state);
        log.debug(`Checking read access for ${ctx.user.email} to ${type} doc ${doc.id}`);
        try { await this.assertInUserGroups(ctx, docState.read, type, doc); } catch (e) {
            log.debug(`Read access denied for ${ctx.user.email}`);
            return false;
        }
        return true;
    }

    public async hasWriteAccess(ctx: UserContext, type: string, doc: any): Promise<boolean> {
        const docState = await this.getDocState(ctx, type, doc.state);
        try { await this.assertInUserGroups(ctx, docState.write, type, doc); } catch (e) { return false; }
        return true;
    }

    public async hasDeleteAccess(ctx: UserContext, type: string, doc: any): Promise<boolean> {
        const docState = await this.getDocState(ctx, type, doc.state);
        try { await this.assertInUserGroups(ctx, docState.delete, type, doc); } catch (e) { return false; }
        return true;
    }

    public async updateArgs(ctx: UserContext, ds: DocSpec, args: any): Promise<any> {
        return args;
    }

    public async updateDoc(ctx: UserContext, ds: DocSpec, args: any): Promise<any> {
        const caller = ctx.user.email;
        log.debug(`'${caller}' is updating doc '${ds.type}/${ds.id}': ${JSON.stringify(args)}`);
        ctx.docId = ds.id;
        const type = ds.type;
        ctx.mode = 'update';
        ctx.updates = args;
        const doc = await this._getDoc(ctx, ds);
        const docState = await this.getDocState(ctx, ds.type, doc.state);
        const docType = this.getDocType(type);
        const hasNonStateChange = this.hasNonStateKey(args);
        const admin = await this.isAdmin(ctx);
        if (!args.hasOwnProperty('$push')) { args['$push'] = {}; }

        if (docType.onUpdate) {
            const r = await docType.onUpdate(this, ctx, ds, JSON.parse(JSON.stringify(args)));
            if (r) { args = r; ctx.updates = args; }
        }

        const newState = args.state;
        const comments: CommentInfo[] = [];
        const now = Date.now();
        const person = { ...ctx.user } as any;
        delete person.id;
        delete person.roles;

        if (docType.includeComments && args.comment) {
            comments.push({
                id: uuidv4(), user: person, text: args.comment.text,
                topic: args.comment.topic, date: now,
                approved: args.comment.approved || '', private: args.comment.private || false,
            });
            delete args.comment;
        }

        if (newState) {
            log.debug(`Checking permission for '${caller}' to move from '${doc.state}' to '${newState}'`);
            if (docState.nextStates[args.state]) {
                await this.assertInUserGroups(ctx, docState.nextStates[args.state].groups, type, doc);
            } else {
                log.debug(`Moving from '${doc.state}' to '${newState}' is not valid.`);
                if (!admin) { throwErr(500, 'Invalid next state'); }
                log.debug(`But allowed since user is admin`);
            }
            if (docState.exit) { await this.assertInUserGroups(ctx, docState.exit, type, doc); }

            if (docType.includeComments) {
                const _docStates = this.getDocType(type)?.states;
                const newStateLabel = _docStates?.[newState]?.label;
                comments.push({
                    id: uuidv4(), user: person, text: `<p>Changed to state '${newStateLabel}'<p>`,
                    topic: 'state', date: now, approved: '', private: false,
                });
            }

            if (docType.includeStateHistory) {
                const sh: StateHistory = { state: newState, date: now, email: ctx.user.email };
                args['$push'].stateHistory = sh;
            }

            const newDocState = await this.getDocState(ctx, ds.type, newState);
            if (hasNonStateChange) {
                log.debug(`Checking permission for '${caller}' to write to state '${newState}'`);
                await this.assertWriteAccess(ctx, ds.type, doc);
                if (docState.onWrite) {
                    await docState.onWrite(new StateCallbackContextImpl(ctx, this, type, this.toInfo(doc, true)));
                }
            }

            if (newDocState.entry) {
                await this.assertInUserGroups(ctx, newDocState.entry, type, doc);
            }

            const action = docState.nextStates[args.state]?.action;
            if (action) {
                await action(new StateCallbackContextImpl(ctx, this, type, this.toInfo(doc, true)));
            }

            if (doc.state == newState && newDocState.onReentry) {
                await newDocState.onReentry(new StateCallbackContextImpl(ctx, this, type, this.toInfo(doc, true)));
            } else if (newDocState.onEntry) {
                await newDocState.onEntry(new StateCallbackContextImpl(ctx, this, type, this.toInfo(doc, true)));
            }

            args.curStateRead = (await this.getInUserGroups(ctx, newDocState.read, type, doc)) || [];
            args.curStateWrite = (await this.getInUserGroups(ctx, newDocState.write, type, doc)) || [];
        } else if (hasNonStateChange) {
            log.debug(`Checking permission for '${caller}' to write to state '${doc.state}'`);
            await this.assertWriteAccess(ctx, ds.type, doc);
            if (docState.onWrite) {
                await docState.onWrite(new StateCallbackContextImpl(ctx, this, type, this.toInfo(doc, true)));
            }
            args.curStateRead = (await this.getInUserGroups(ctx, docState.read, type, doc)) || [];
            args.curStateWrite = (await this.getInUserGroups(ctx, docState.write, type, doc)) || [];
        }

        if (docType.includeComments && comments.length > 0) {
            log.debug(`Adding comments: ${JSON.stringify(comments, null, 4)}`);
            args['$push'].comments = { '$each': comments };
        }

        if (!Object.keys(args['$push']).length) { delete args['$push']; }
        if (docType.includeDateUpdated) { args.dateUpdated = now; }

        // ── PostgreSQL update ──────────────────────────────────────────────────
        const pc = await this.getDocCollection(ds.type);
        const newArgs = await this.updateArgs(ctx, ds, args);
        await pc.updateOne(ds.id, this.toDbUpdate(newArgs));

        let updatedDoc = await this._getDoc(ctx, ds);
        if (docType.onPostUpdate) {
            const r = await docType.onPostUpdate(this, ctx, ds.type, this.toInfo(updatedDoc, true));
            if (r) { updatedDoc = r; }
        }
        if (docType.includeComments) { this.emailComments(ctx, ds, updatedDoc); }
        return updatedDoc;
    }

    public async deleteDoc(ctx: UserContext, ds: DocSpec): Promise<any> {
        log.debug(`Deleting doc: ${JSON.stringify(ds)}`);
        ctx.docId = ds.id;
        ctx.mode = 'delete';
        let doc = await this._getDoc(ctx, ds);
        const docState = await this.getDocState(ctx, ds.type, doc.state);
        if (docState.delete) {
            await this.assertDeleteAccess(ctx, ds.type, doc);
        } else {
            await this.assertWriteAccess(ctx, ds.type, doc);
        }
        const docType = this.getDocType(ds.type);
        if (docType.onDelete) {
            const r = await docType.onDelete(this, ctx, ds.type, this.toInfo(doc, true));
            if (r) { doc = r; }
        }
        if (docState.onDelete) {
            await docState.onDelete(new StateCallbackContextImpl(ctx, this, ds.type, this.toInfo(doc, true)));
        }

        // ── PostgreSQL delete ──────────────────────────────────────────────────
        const pc = await this.getDocCollection(ds.type);
        await pc.deleteOne(ds.id);
        log.debug(`Deleted doc: ${JSON.stringify(ds)}`);

        if (docType.onPostDelete) {
            const r = await docType.onPostDelete(this, ctx, ds.type, this.toInfo(doc, true));
            if (r) { return r; }
        }
        return doc;
    }

    public async deleteMany(ctx: UserContext, type: string, match: any, test?: boolean): Promise<any[] | number> {
        this.assertAdmin(ctx);
        log.debug(`deleteMany(${type}, ${JSON.stringify(match)})`);
        const pc = await this.getDocCollection(type);
        let _match: any = {};
        if (typeof match === 'string') { _match = JSON.parse(match); }
        else if (match) { _match = match; }
        if (_match.id) {
            _match._id = _match.id;
            delete _match.id;
        }
        if (test) {
            return await pc.find(_match, {});
        } else {
            return await pc.deleteMany(_match);
        }
    }

    // ── User Groups ───────────────────────────────────────────────────────────

    public async createUserGroup(
        ctx: UserContext,
        args: UserGroupCreate,
        defaultMembers?: Person[]
    ): Promise<UserGroupInfo> {
        log.debug(`Creating user group: ${JSON.stringify(args)}`);
        await this.assertAdmin(ctx);
        const uc = await this.getUserCollection();
        const existing = await uc.findOne(args.id);
        if (existing) { return throwErr(400, `User group '${args.id}' already exists`); }
        args.deletable = args.deletable || false;
        args.members = args.members || defaultMembers || [];
        await uc.insertUserGroup(args);
        return await this.getUserGroup(ctx, args.id);
    }

    public async getUserGroups(): Promise<UserGroupList> {
        const uc = await this.getUserCollection();
        const items: any = await uc.findAllGroups();
        return { count: items.length, items };
    }

    public async lookupUserGroup(ctx: UserContext, id: string): Promise<UserGroupInfo | undefined> {
        log.debug(`Getting user group '${id}'`);
        if (this.userGroupCache[id]) {
            log.debug(` -- found user group ${id} in cache`);
            return this.userGroupCache[id];
        }
        const uc = await this.getUserCollection();
        const result = await uc.findOne(id);
        if (result) {
            const info = result as UserGroupInfo;
            this.userGroupCache[id] = info;
            return info;
        }
        log.debug(`User group '${id}' was not found`);
        return undefined;
    }

    public async getUserGroup(ctx: UserContext, id: string): Promise<UserGroupInfo> {
        const info = await this.lookupUserGroup(ctx, id);
        if (info) { return info; }
        return throwErr(404, `user group '${id}' was not found`);
    }

    public async getOrCreateUserGroup(
        ctx: UserContext,
        args: UserGroupCreate,
        defaultMembers?: Person[]
    ): Promise<UserGroupInfo> {
        log.debug(`Get or create user group: ${JSON.stringify(args)}`);
        if (this.userGroupCache[args.id]) {
            log.debug(` -- found user group ${args.id} in cache`);
            return this.userGroupCache[args.id];
        }
        const uc = await this.getUserCollection();
        const result = await uc.findOne(args.id);
        if (result) {
            log.debug(`User group ${args.id} already exists`);
            return result as UserGroupInfo;
        }
        return await this.createUserGroup(ctx, args, defaultMembers);
    }

    public async updateUserGroup(ctx: UserContext, id: string, args: UserGroupUpdate): Promise<UserGroupInfo> {
        log.debug(`Updating user group '${id}': ${JSON.stringify(args)}`);
        await this.assertAdmin(ctx);
        const uc = await this.getUserCollection();
        await uc.updateOne(id, args);
        if (this.userGroupCache[id]) { delete this.userGroupCache[id]; }
        return await this.getUserGroup(ctx, id);
    }

    public async deleteUserGroup(ctx: UserContext, id: string): Promise<UserGroupInfo> {
        log.debug(`Deleting user group '${id}'`);
        await this.assertAdmin(ctx);
        const result = await this.getUserGroup(ctx, id);
        if (!result.deletable) { return throwErr(403, `The '${id}' user group can not be deleted`); }
        const uc = await this.getUserCollection();
        await uc.deleteOne(id);
        if (this.userGroupCache[id]) { delete this.userGroupCache[id]; }
        return result;
    }

    // ── Group membership ──────────────────────────────────────────────────────

    public async isInUserGroup(ctx: UserContext, groupName: string, type?: string, doc?: any): Promise<boolean> {
        log.debug('isInUserGroup: user=', ctx.user.email, 'group=', groupName);
        if (ctx.user.roles.includes(groupName)) { return true; }
        const members = await this.getMembers(ctx, groupName, type, doc);
        const email = ctx.user.email;
        if (members) {
            for (const member of members) {
                if (member.email === email) { return true; }
            }
        }
        return false;
    }

    public async getMembers(ctx: UserContext, groupName: string, type?: string, doc?: any): Promise<Person[]> {
        log.debug('getMembers: groupName=', groupName);
        const roles = await this.getDocRoles(ctx, type);
        if (roles[groupName]) {
            const m = roles[groupName].getMembers;
            if (typeof m === 'function') {
                if (doc && type) {
                    return await m(new StateCallbackContextImpl(ctx, this, type, this.toInfo(doc, true)));
                }
                return [];
            } else {
                groupName = m;
                return await this._getMembers(ctx, m, doc);
            }
        }
        return await this._getMembers(ctx, groupName, doc);
    }

    protected async _getMembers(ctx: UserContext, groupName: string, doc?: any): Promise<Person[]> {
        if (doc) {
            try { return getField(groupName, doc); } catch (e) {}
        }
        const ug = await this.lookupUserGroup(ctx, groupName);
        if (!ug) { return []; }
        return ug.members;
    }

    public async isInUserGroups(
        ctx: UserContext, groupNames: string[], type?: string, doc?: any, fromIsAdmin?: boolean
    ): Promise<boolean> {
        for (const groupName of groupNames) {
            const isMember = await this.isInUserGroup(ctx, groupName, type, doc);
            if (isMember) { return true; }
        }
        if (!fromIsAdmin) {
            const admin = await this.isAdmin(ctx);
            if (admin) { return true; }
        }
        return false;
    }

    public async assertInUserGroups(
        ctx: UserContext, arg: StateCallback | string[] | undefined, type: string, doc: any
    ) {
        if (arg === undefined) { return; }
        const groups = await this.getInUserGroups(ctx, arg, type, doc);
        if (!groups || groups.length == 0) { throwErr(401, `${ctx.user.email} is not authorized`); }
        const ok = await this.isInUserGroups(ctx, groups, type, doc);
        if (!ok) {
            if (await this.isAdmin(ctx)) { return; }
            throwErr(401, `${ctx.user.email} is not authorized`);
        }
    }

    public async getInUserGroups(
        ctx: UserContext, arg: StateCallback | string[] | undefined, type: string, doc: any
    ) {
        if (typeof arg === 'function') {
            return (await arg(new StateCallbackContextImpl(ctx, this, type, this.toInfo(doc, true)))).groups;
        } else {
            return arg;
        }
    }

    public async isAdmin(ctx: UserContext): Promise<boolean> {
        const uid = ctx.user.id;
        if (ctx.isAdmin == undefined) {
            if (adminIds.indexOf(uid) >= 0) { ctx.isAdmin = true; return true; }
            if (ctx.user.roles.includes(this.adminRole)) { ctx.isAdmin = true; return true; }
            const r = await this.isInUserGroups(ctx, this.adminGroups, undefined, undefined, true);
            ctx.isAdmin = r;
            return r;
        }
        return ctx.isAdmin ?? false;
    }

    // ── Comments (verbatim from original) ─────────────────────────────────────

    public async addComment(ctx: UserContext, ds: DocSpec, args: CommentCreate): Promise<any> {
        log.debug(`addComment(${ds.id}, ${JSON.stringify(args)})`);
        const doc = await this.getDoc(ctx, ds);
        const docState = await this.getDocState(ctx, ds.type, doc.state);
        if (docState.commentWrite) {
            await this.assertInUserGroups(ctx, docState.commentWrite, ds.type, doc);
        }
        const person = { ...ctx.user } as any;
        delete person.id; delete person.roles;
        const comment = {
            id: uuidv4(), user: person, text: args.text, topic: args.topic,
            approved: args.approved || '', private: args.private || false, date: Date.now(),
        };
        this.considerCommentForEmailing(ctx, ds, comment);
        let data = { '$push': { 'comments': comment } };
        const pc = await this.getDocCollection(ds.type);
        await pc.updateOne(ds.id, this.toDbUpdate(data));
        const r = await this._getDoc(ctx, ds);
        this.emailComments(ctx, ds, r);
        return r;
    }

    public async getComment(ctx: UserContext, ds: DocSpec, cid: string): Promise<CommentInfo> {
        const doc = await this.getDoc(ctx, ds);
        for (var i in doc.comments) {
            if (doc.comments[i].id == cid) { return doc.comments[i]; }
        }
        throwErr(404, `Comment ${cid} not found`);
    }

    public async updateComment(ctx: UserContext, ds: DocSpec, cid: string, args: CommentUpdate): Promise<any> {
        log.debug(`updateComment(${ds.id}, ${cid}, ${JSON.stringify(args)})`);
        const doc = await this.getDoc(ctx, ds);
        for (var i in doc.comments) {
            if (doc.comments[i].id == cid) {
                const comment = { ...doc.comments[i], ...args };
                if (comment.edited === undefined) { comment.edited = []; }
                delete (comment.user as any).id; delete (comment.user as any).roles;
                if (args.text !== undefined) {
                    comment.edited.push({ date: comment.date, user: comment.user });
                    comment.date = Date.now();
                    const user = { ...ctx.user } as any;
                    delete user.id; delete user.roles;
                    comment.user = user;
                }
                if (await this.canEditComment(ctx, comment)) {
                    let data = { '$set': { ['comments.' + i]: comment } };
                    const pc = await this.getDocCollection(ds.type);
                    await pc.updateOne(ds.id, this.toDbUpdate(data));
                    const r = await this._getDoc(ctx, ds);
                    this.emailComments(ctx, ds, r);
                    return r;
                }
                throwErr(400, `User does not have permission to update comment ${cid}`);
            }
        }
        throwErr(404, `Comment ${cid} not found`);
    }

    public async deleteComment(ctx: UserContext, ds: DocSpec, cid: string): Promise<any> {
        log.debug(`deleteComment(${ds.id}, ${cid})`);
        const comment = await this.getComment(ctx, ds, cid);
        if (await this.canEditComment(ctx, comment)) {
            const filter = { '$pull': { 'comments': { 'id': cid } } };
            const pc = await this.getDocCollection(ds.type);
            await pc.updateOne(ds.id, this.toDbUpdate(filter));
            return await this._getDoc(ctx, ds);
        }
        throwErr(400, `User does not have permission to delete comment ${cid}`);
    }

    public async canViewComment(ctx: UserContext, ds: DocSpec, comment: CommentInfo) {
        if (!comment.private) { return true; }
        if (await this.canEditComment(ctx, comment)) { return true; }
        const docType = this.getDocType(ds.type);
        const keyWords = docType.commentKeyWords;
        if (keyWords) {
            const allTags = comment.text.match(/@([a-zA-Z]+)/gi);
            if (allTags) {
                for (const tag of allTags) {
                    const keyWord = tag.substring(1);
                    if (keyWords[tag.toLowerCase()]) {
                        if (await this.isInUserGroups(ctx, keyWords[tag])) { return true; }
                    } else {
                        if (await this.lookupUserGroup(ctx, keyWord)) { return true; }
                    }
                }
            }
        }
        return false;
    }

    public async canEditComment(ctx: UserContext, comment: CommentInfo) {
        if (await this.isAdmin(ctx)) { return true; }
        const email = ctx.user.email;
        if (comment.topic == 'state') { return false; }
        if (comment.user.email == email) { return true; }
        if (comment.edited && comment.edited.length > 0) {
            for (var c of comment.edited) {
                if (c.user.email == email) { return true; }
            }
        }
        return false;
    }

    public async considerCommentForEmailing(ctx: UserContext, ds: DocSpec, comment: CommentInfo) {
        const docType = this.getDocType(ds.type);
        const keyWords = docType.commentKeyWords;
        if (!keyWords) { return; }
        const allTags = comment.text.match(/@([a-zA-Z]+)/gi);
        if (allTags) {
            for (const tag of allTags) {
                const keyWord = tag.substring(1);
                if (keyWords[tag.toLowerCase()]) {
                    this.addCommentToEmail(ctx, comment, keyWords[tag]);
                } else {
                    const group = await this.lookupUserGroup(ctx, keyWord);
                    if (group) { this.addCommentToEmail(ctx, comment, [keyWord]); }
                }
            }
        }
        const emails = comment.text.match(/@([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/gi);
        emails?.forEach(email => { this.addCommentToEmail(ctx, comment, [email.substring(1)]); });
    }

    public addCommentToEmail(ctx: UserContext, comment: CommentInfo, group: string[]) {
        if (!ctx.props) { ctx.props = {}; }
        if (!ctx.props.emailComments) { ctx.props.emailComments = []; }
        let found = false;
        for (var c of ctx.props.emailComments) {
            if (c.id == comment.id) { found = true; break; }
        }
        if (!found) { ctx.props.emailComments.push({ comment: comment, group: group }); }
    }

    public emailComments(ctx: UserContext, ds: DocSpec, doc: any) {
        if (!ctx.props || !ctx.props.emailComments) { return; }
        for (var entry of ctx.props.emailComments) {
            const comment = entry.comment;
            var text = `
                <html><head><style>.commentDiv{border:1px solid lightgray;border-radius:8px;padding:12px;}</style></head>
                <body>
                <div style="padding-bottom:16px;"><div>Hello %name%, </div>
                <p>You have received a comment for document ${doc.id}.</p></div>
                <div class="commentDiv">
                <div><span style="font-weight:bold;">${comment.user.name}</span> - &nbsp;
                <span style="font-size:smaller;font-style:italic;">${formatDateTime(comment.date)}</span></div>
                <div>${comment.text}</div></div></body></html>`;
            this.sendNotifications(ctx, ds.type, doc, entry.group, 'Comment', text);
        }
        ctx.props.emailComments = [];
    }

    public async assertAdmin(ctx: UserContext) {
        const ok = await this.isAdmin(ctx);
        if (!ok) { return throwErr(401, `Caller is not admin`); }
    }

    // ── Attachments ───────────────────────────────────────────────────────────
    // Attachment binary data is stored directly in PostgreSQL (as BYTEA) in the
    // polyglot edition, matching the original MongoDB GridFS behavior exactly.
    // For S3-backed binary storage, use the dlms-server-pg infra variant.

    public async createAttachment(ctx: UserContext, args: any): Promise<AttachmentModel> {
        log.debug(`Creating attachment: ${JSON.stringify(this.toAttachmentInfoString(args))}`);
        const pc = await this.getAttachmentCollection();
        const id = await pc.insertOne(args);
        args._id = id;
        return await this.getAttachment(ctx, id);
    }

    public async getAttachment(_ctx: UserContext, id: string): Promise<AttachmentModel> {
        log.debug(`Getting attachment '${id}'`);
        const pc = await this.getAttachmentCollection();
        const result: any = await pc.findOne(id);
        if (result) { return result; }
        return throwErr(404, `attachment '${id}' was not found`);
    }

    public async getAttachmentForDoc(_ctx: UserContext, docId: string, id: string): Promise<AttachmentModel> {
        log.debug(`Getting attachment '${id}' for doc '${docId}'`);
        const pc = await this.getAttachmentCollection();
        const result: any = await pc.findOneWhere({ _id: id, doc: docId });
        if (result) { return result; }
        return throwErr(404, `attachment '${id}' was not found`);
    }

    public async getAttachments(_ctx: UserContext, args?: { match?: any; filter?: any }): Promise<AttachmentModel[]> {
        log.debug(`Getting attachments`);
        const pc = await this.getAttachmentCollection();
        args = args || {};
        const match = args.match || {};
        return (await pc.find(match, {})).map(p => {
            log.debug(JSON.stringify(this.toAttachmentInfoString(p)));
            return p as any;
        });
    }

    public async updateAttachment(ctx: UserContext, id: string, args: any): Promise<AttachmentModel> {
        log.debug(`Updating attachment '${id}'`);
        const pc = await this.getAttachmentCollection();
        await pc.updateOne(id, args);
        return await this.getAttachment(ctx, id);
    }

    public async deleteAttachment(ctx: UserContext, id: string): Promise<AttachmentModel> {
        log.debug(`Deleting attachment '${id}'`);
        const result = await this.getAttachment(ctx, id);
        const pc = await this.getAttachmentCollection();
        await pc.deleteOne(id);
        return result;
    }

    // ── Email notifications (verbatim) ────────────────────────────────────────

    public async sendNotifications(
        ctx: UserContext, type: string, doc: any, groups: string[],
        subject: string, message: string, fromEmail: string = '',
        attachments: EmailAttachment[] = [], sendSingle?: boolean
    ) {
        /* eslint-disable @typescript-eslint/no-this-alias*/
        const self = this;
        /* eslint-enable @typescript-eslint/no-this-alias*/
        async function getEmailAddresses(ctx: UserContext, groupName: string, doc: any) {
            if (groupName.indexOf('@') > -1) {
                try {
                    const profile = await self.userProfileService.get(groupName);
                    const user = profile[0];
                    return [{ name: user.user.name, department: user.user.department, email: user.user.email, title: user.user.title, employeeNumber: user.user.employeeNumber }];
                } catch (e) {}
                return [{ email: groupName, name: '', title: '', department: '', employeeNumber: '' }];
            } else {
                return await self.getMembers(ctx, groupName, type, doc);
            }
        }
        const excludeEmails = [];
        for (const group of groups) {
            if (group.charAt(0) === '!') { excludeEmails.push(group.substring(1).toLowerCase()); }
        }
        for (const group of groups) {
            if (group.charAt(0) != '!') {
                try {
                    const toEmails = await getEmailAddresses(ctx, group, doc);
                    const sendEmails = toEmails.filter(e => !excludeEmails.includes(e.email.toLowerCase()));
                    if (sendEmails.length > 0) {
                        await this.sendEmailToGroup(ctx, sendEmails, subject, message, fromEmail, attachments, sendSingle);
                    }
                } catch (e: any) { log.debug(e.message); }
            }
        }
    }

    public async sendEmailToGroup(ctx: UserContext, toEmails: Person[], subject: string, message: string, fromEmail: string = '', attachments: EmailAttachment[] = [], sendSingle?: boolean) {
        const processNotificationContent = (member: Person, s: string) => {
            s = s.replace(/%title%/g, member.title);
            try { s = s.replace(/%name%/g, member.name || member.email.split('@')[0]); } catch (e) {}
            s = s.replace(/%department%/g, member.department);
            s = s.replace(/%employeeNumber%/g, member.employeeNumber);
            s = s.replace(/%email%/g, member.email);
            return s;
        };
        for (const member of toEmails) {
            await this.sendEmail(ctx, member.email, processNotificationContent(member, subject), processNotificationContent(member, message), fromEmail, attachments, sendSingle);
        }
    }

    public async sendEmail(ctx: UserContext, toEmail: string, subject: string, message: string, fromEmail: string = '', attachments: EmailAttachment[] = [], force: boolean = false) {
        const from = fromEmail || this.email;
        if (!emailEnabled && !force) {
            log.info(`Email disabled. Not sending to ${toEmail}: subject=${subject}`);
            return;
        }
        /* eslint-disable @typescript-eslint/no-this-alias*/
        const self = this;
        /* eslint-enable @typescript-eslint/no-this-alias*/
        setTimeout(async function () {
            try {
                log.info(`Sending email to ${toEmail}: subject=${subject}`);
                const isHtml = message.indexOf('</') > -1;
                await self.transporter.sendMail({ from, to: toEmail, subject, text: message, html: isHtml ? message : undefined, attachments });
                log.info(`Sent email to ${toEmail}`);
            } catch (e: any) { log.info(`Failed to send email to ${toEmail}: ${e.stack}`); }
        }, 100);
    }

    // ── Export / Import / Reset ───────────────────────────────────────────────

    public async export(ctx: UserContext): Promise<any> {
        log.debug('export: enter');
        await this.assertAdmin(ctx);
        const rtn: any = {};
        for (const cName of this.allCollectionNames) {
            const c = await this.getCollection(cName);
            rtn[cName] = await c.find({}, {});
        }
        log.debug(`export: exit`);
        return rtn;
    }

    public async exportIds(ctx: UserContext): Promise<any> {
        await this.assertAdmin(ctx);
        log.debug('exportIds: enter');
        const rtn: any = {};
        for (const cName of this.allCollectionNames) {
            const c = await this.getCollection(cName);
            const all = await c.find({}, {});
            rtn[cName] = all.map((d: any) => d._id || d.id);
        }
        log.debug(`exportIds: exit`);
        return rtn;
    }

    public async exportId(ctx: UserContext, cName: string, id: string): Promise<any> {
        await this.assertAdmin(ctx);
        log.debug(`exportId: enter - ${cName} ${id}`);
        const c = await this.getCollection(cName);
        const rtn = await c.findOne(id);
        log.debug(`exportId: exit - ${cName} ${id}`);
        return rtn;
    }

    public async importId(ctx: UserContext, cName: string, id: string, ele: any): Promise<any> {
        log.debug(`importId: enter - ${cName} ${id}`);
        await this.assertAdmin(ctx);
        try {
            const c = await this.getCollection(cName);
            if (cName == this.attachmentCollectionName) {
                ele.data = Buffer.from(ele.data, 'base64');
            }
            await c.upsertOne(id, ele);
            const cur = await c.findOne(id);
            log.debug(`importId: exit - ${cName} ${id}`);
            return cur;
        } catch (e) {
            log.err(`importId: Error importing = ${e}`);
            return null;
        }
    }

    public async import(ctx: UserContext, toImport: any) {
        log.debug(`import: enter`);
        await this.assertAdmin(ctx);
        for (const cName in toImport) {
            log.debug(`     importing collection ${cName}`);
            const contents = toImport[cName];
            const c = await this.getCollection(cName);
            for (const entry of contents as any[]) {
                if (!entry.hasOwnProperty('_id')) {
                    return throwErr(400, `The following ${cName} entry has no '_id' field: ${JSON.stringify(entry)}`);
                }
                const id = entry['_id'];
                const result: any = await c.findOne(id);
                if (result) {
                    log.debug(`         not inserting ${id} because it was already found`);
                } else {
                    log.debug(`        inserting ${id}`);
                    await c.insertOne(entry);
                }
            }
        }
        log.debug(`import: exit`);
    }

    public async reset(ctx: UserContext, simpleInit: boolean = false) {
        log.info('reset: enter');
        await this.assertAdmin(ctx);
        for (const cName of this.allCollectionNames) {
            log.info(`    dropping collection ${cName}`);
            const c = await this.getCollection(cName);
            try { await c.drop(); } catch (e: any) { log.info(`Failed to drop collection ${cName}: ${e.message}`); }
        }
        this.initialized = false;
        this.initHasBeenCalled = false;
        this.userGroupCache = {};
        await this.init(simpleInit);
        log.info('reset: exit');
    }

    // ── Utility methods (unchanged from original) ─────────────────────────────

    public getCtx(req: any): UserContext {
        const ctx = req._ctx;
        if (!ctx) { throwErr(500, "No '_ctx' field was found on request"); }
        return ctx;
    }

    public getMyUserMatchValue(ctx: UserContext): string {
        return ctx.user.email;
    }

    public createMyUserMatchFilter(ctx: UserContext, field: string): object {
        const filter: any = {};
        filter[`${field}.email`] = this.getMyUserMatchValue(ctx);
        return filter;
    }

    /**
     * toDbUpdate: translates the original MongoDB update syntax ($set, $push, $pull)
     * into a format understood by PgAdapter, which then applies the operations to the
     * JSONB `data` column.  The original method was named `toMongoUpdate`; the logic
     * is identical — only the name changed to reflect database-agnosticism.
     */
    public toDbUpdate(obj: any): any {
        const setObj: any = {};
        const result: any = { $set: setObj };
        Object.keys(obj).forEach(function (key: string) {
            const val = obj[key];
            if (key.startsWith('$')) {
                if (!(key in result)) { result[key] = {}; }
                result[key] = { ...result[key], ...val };
            } else if (key === 'state') {
                setObj[key] = val.split('$')[0];
            } else {
                setObj[key] = val;
            }
        });
        return result;
    }

    /** Kept for backwards compatibility with any code calling toMongoUpdate */
    public toMongoUpdate(obj: any): any {
        return this.toDbUpdate(obj);
    }

    // ── Collection/connection accessors → now delegate to PgAdapter ───────────

    public async getDocCollection(type: string): Promise<any> {
        return this.getCollection(this.getDocCollectionName(type));
    }

    public async getUserCollection(): Promise<any> {
        return this.getCollection(this.userCollectionName);
    }

    public async getAttachmentCollection(): Promise<any> {
        return this.getCollection(this.attachmentCollectionName);
    }

    public async getCollection(name: string): Promise<any> {
        return this.db.collection(name);
    }

    public getDocCollectionName(type: string): string {
        const cName = this.documents[type]?.collectionName;
        if (cName) { return `${this.appName}.${cName}`; }
        return `${this.appName}.${type}.doc`;
    }

    public getBaseUrl() {
        return this.cfg('URL', 'http://127.0.0.1:3001');
    }

    public cfg(name: string, def?: string): string {
        const rtn = process.env[name];
        if (!rtn) {
            if (def) { return def; }
            return throwErr(500, `${name} environment variable is not set`);
        }
        return rtn;
    }

    public toInfo(doc: any, copy: boolean): any {
        if (copy) { doc = JSON.parse(JSON.stringify(doc)); }
        if (!doc.id) {
            if (doc._id) {
                const id = doc._id.toString();
                doc = { id, ...doc };
            }
        }
        delete doc._id;
        return doc;
    }

    public toAttachmentInfoString(ele: any): any {
        if ('data' in ele) { ele = { ...ele, data: '...' }; }
        return ele;
    }

    public hasNonStateKey(args: any): boolean {
        for (const key of Object.keys(args)) {
            if (key !== 'state') { return true; }
        }
        return false;
    }
}

// ── StateCallbackContextImpl (verbatim from original) ─────────────────────────

export class StateCallbackContextImpl implements StateCallbackContext {
    public caller: PersonWithId;
    public document: DocInfo;
    public type: string;
    public updates: any;
    private ctx: UserContext;
    private mgr: DocMgr;
    private doc: any;

    constructor(ctx: UserContext, mgr: DocMgr, type: string, doc: any) {
        this.caller = ctx.user;
        this.document = doc;
        this.type = type;
        this.updates = ctx.updates;
        this.ctx = ctx;
        this.mgr = mgr;
        this.doc = doc;
    }

    public async isCallerInGroup(groups: string[]): Promise<boolean> {
        return await this.mgr.isInUserGroups(this.ctx, groups, this.type, this.doc);
    }

    public async assertCallerInGroup(groups: string[]) {
        await this.mgr.assertInUserGroups(this.ctx, groups, this.doc, this.type);
    }

    public async notify(groups: string[], subject: string, message: string, fromEmail: string = '', attachments: EmailAttachment[] = [], sendSingle?: boolean) {
        await this.mgr.sendNotifications(this.ctx, this.type, this.doc, groups, subject, message, fromEmail, attachments, sendSingle);
    }

    public getUserContext(): UserContext { return this.ctx; }
    public getDocMgr(): DocMgr { return this.mgr; }
    public accessDeniedError(): void { throwErr(401, 'Access denied'); }
    isCreate(): boolean { return this.ctx.mode === 'create'; }
    isRead(): boolean { return this.ctx.mode === 'read'; }
    isUpdate(): boolean { return this.ctx.mode === 'update'; }
    isDelete(): boolean { return this.ctx.mode === 'delete'; }
}
