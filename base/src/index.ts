/**
 * dlms-base-pg – shared types for the DLMS AWS Polyglot edition.
 *
 * This module re-exports every public interface from the original dlms-base
 * package and adds polyglot-specific extensions so that server and sample-app
 * code can import from a single location.
 */

// ─── Core User / Auth types ──────────────────────────────────────────────────

export interface Person {
  name: string;
  department: string;
  email: string;
  title: string;
  employeeNumber: string;
  [key: string]: any;
}

export interface PersonWithId extends Person {
  id: string;
}

export interface User extends Person {
  id: string;
  roles: string[];
}

export interface UserContext {
  user: User;
  docId?: string;
  updates?: any;
  mode?: "create" | "read" | "update" | "delete";
  isAdmin?: boolean;
  [key: string]: any;
}

export interface UserProfileService {
  get(claimsOrUid: any): Promise<UserContext[]>;
  verify(uid: string, pwd: string): Promise<UserContext>;
}

// ─── Document / State types ───────────────────────────────────────────────────

export type StateCallback =
  | string[]
  | ((ctx: StateCallbackContext) => Promise<{ groups?: string[]; roles?: string[] } | void>);

export type StateActionCallback = (ctx: StateCallbackContext) => Promise<any>;

export interface PossibleStates {
  [stateName: string]: {
    groups?: string[];
    label: string;
    description: string;
    puml?: any;
  };
}

export interface PumlState {
  title: string;
  content?: string[];
  color?: string;
}

export interface DocState {
  label: string;
  description: string;
  entry?: StateCallback;
  onEntry?: StateActionCallback;
  onReentry?: StateActionCallback;
  read?: StateCallback;
  onRead?: StateActionCallback;
  write?: StateCallback;
  onWrite?: StateActionCallback;
  exit?: StateCallback;
  onExit?: StateActionCallback;
  delete?: StateCallback;
  onDelete?: StateActionCallback;
  action?: StateActionCallback;
  puml?: PumlState;
  nextStates: PossibleStates;
}

export interface DocType {
  states: { [name: string]: DocState };
  collectionName?: string;
  docRoles?: Roles;
  document_id_required?: boolean;
}

export interface Document extends DocType {}

export interface Documents {
  [name: string]: DocType;
}

export interface Roles {
  [roleName: string]:
    | string
    | {
        name: string;
        getMembers?: (ctx: StateCallbackContext) => Promise<Person[] | string[]>;
      };
}

export interface StateCallbackContext {
  user: User;
  document: any;
  isCallerInGroup(groups: string[]): Promise<boolean>;
  accessDeniedError(): never;
  notify(recipients: Person[], subject: string, body: string): Promise<void>;
  [key: string]: any;
}

// ─── DocMgr Init types ────────────────────────────────────────────────────────

export interface DocMgrCreateArgs {
  appName: string;
  documents: Documents;
  userGroups: UserGroupCreate[];
  adminGroups: string[];
  adminRole: string;
  managerRole?: string;
  roles: string[];
  email: string;
  /** Polyglot: PostgreSQL connection URL (overrides PG_* env vars) */
  pgUrl?: string;
  /** Polyglot: OpenSearch endpoint URL (overrides OPENSEARCH_* env vars) */
  openSearchUrl?: string;
  userProfileService?: UserProfileService;
}

// ─── User Group types ─────────────────────────────────────────────────────────

export interface UserGroupCreate {
  id: string;
  deletable?: boolean;
  members?: Person[];
}

export interface UserGroupInfo extends UserGroupCreate {
  id: string;
  members: Person[];
}

export interface UserGroupUpdate {
  members?: Person[];
}

export interface UserGroupList {
  count: number;
  items: UserGroupInfo[];
}

// ─── Doc list / attachment types ─────────────────────────────────────────────

export interface DocList {
  count: number;
  items: any[];
}

export interface AttachmentInfo {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  docId: string;
  collection: string;
  createdAt: string;
  updatedAt: string;
  /** S3 key for binary storage */
  s3Key?: string;
}

// ─── Error types ──────────────────────────────────────────────────────────────

export class DocError extends Error {
  public readonly scode: number;
  constructor(scode: number, msg: string) {
    super(msg);
    this.scode = scode;
  }
}

export function throwErr(scode: number, msg: string): never {
  throw new DocError(scode, msg);
}

// ─── Polyglot-specific DB Adapter interface ───────────────────────────────────

/**
 * DbAdapter abstracts all persistence operations so that the DocMgr layer
 * remains completely database-agnostic.  The PostgreSQL implementation lives
 * in `server/src/db/pgAdapter.ts`; a mock adapter for unit testing is also
 * provided.
 */
export interface DbAdapter {
  // lifecycle
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  healthCheck(): Promise<boolean>;

  // documents
  createDoc(collection: string, doc: any): Promise<any>;
  getDoc(collection: string, id: string): Promise<any | null>;
  updateDoc(collection: string, id: string, patch: any): Promise<any | null>;
  deleteDoc(collection: string, id: string): Promise<any | null>;
  listDocs(collection: string, match?: any, projection?: string[]): Promise<any[]>;

  // user groups
  createGroup(group: UserGroupCreate): Promise<UserGroupInfo>;
  getGroup(id: string): Promise<UserGroupInfo | null>;
  updateGroup(id: string, patch: UserGroupUpdate): Promise<UserGroupInfo | null>;
  deleteGroup(id: string): Promise<UserGroupInfo | null>;
  listGroups(): Promise<UserGroupInfo[]>;

  // attachments (metadata only – binary stored in S3)
  createAttachment(info: Omit<AttachmentInfo, "id">): Promise<AttachmentInfo>;
  getAttachment(id: string): Promise<AttachmentInfo | null>;
  deleteAttachment(id: string): Promise<AttachmentInfo | null>;
  listAttachmentsByDoc(collection: string, docId: string): Promise<AttachmentInfo[]>;
  listAllAttachments(): Promise<AttachmentInfo[]>;

  // admin
  exportAll(): Promise<{ [collection: string]: any[] }>;
  importAll(data: { [collection: string]: any[] }): Promise<void>;
  dropAll(): Promise<void>;
}

/**
 * SearchAdapter abstracts full-text search operations so that the DocMgr
 * layer remains search-engine–agnostic.  The OpenSearch implementation lives
 * in `server/src/db/osAdapter.ts`.
 */
export interface SearchAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  healthCheck(): Promise<boolean>;

  indexDoc(collection: string, doc: any): Promise<void>;
  updateIndexedDoc(collection: string, id: string, doc: any): Promise<void>;
  deleteIndexedDoc(collection: string, id: string): Promise<void>;
  search(collection: string, query: string, filters?: any): Promise<any[]>;
  reindex(collection: string, docs: any[]): Promise<void>;
}
