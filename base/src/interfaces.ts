/**
 * Copyright (c) 2024 Discover Financial Services
 * Polyglot edition: interfaces.ts is unchanged from the original dlms-base.
 * No MongoDB types are present in the base interfaces.
 */

export interface UserContext {
    user: User;
    docId?: string;
    updates?: any;
    mode?: "create" | "read" | "update" | "delete";
    isAdmin?: boolean;
    [key: string]: any;
}

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

export interface UserGroupCreate {
    id: string;
    members?: Person[];
    deletable?: boolean;
    [key: string]: any;
}

export interface UserGroupUpdate {
    members?: Person[];
    [key: string]: any;
}

export interface UserGroupInfo {
    id: string;
    members: Person[];
    deletable: boolean;
    [key: string]: any;
}

export interface UserGroupList {
    count: number;
    items: UserGroupInfo[];
}

export interface AttachmentInfo {
    id: string;
    hash: string;
    collection?: string;
    doc?: string;
    name: string;
    size: number;
    date: number;
    type: string;
    url: string;
    /** S3 key for polyglot binary storage (absent in original MongoDB edition) */
    s3Key?: string;
}

export interface AttachmentModelCreate {
    collection: string;
    doc: string;
    hash: string;
    name: string;
    size: number;
    date: number;
    type: string;
    data: Buffer;
}

export interface AttachmentModel extends AttachmentModelCreate {
    _id: string;
}

export interface DocCreate {
}
export interface DocInfo {
    id: string;
}

export interface DocUpdate {
}

export interface DocList {
    count: number;
    items: any[];
}

export interface EmailAttachment {
    filename: string;
    content: any;
    contentType?: string;
}

export interface StateActionCallbackReturn {
    document?: any;
}
export interface StateCallbackReturn  extends StateActionCallbackReturn {
    groups: string[];
}

export type MemberListCallback = (ctx: StateCallbackContext) => Promise<Person[]>;

export type StateCallback = (ctx: StateCallbackContext) => Promise<StateCallbackReturn>;

export type StateActionCallback = (ctx: StateCallbackContext) => Promise<StateActionCallbackReturn>;

export interface PumlState {
    title?: string;
    content: string[];
    color?: string;
    note?: string;
}

export interface PumlArc {
    title?: string;
    label: string[];
    color?: string;
    note?: string;
    direction?: "up" | "left" | "right" | "down";
}
export interface StateCallbackContext {
    isCallerInGroup(groups: string[]): Promise<boolean>;
    assertCallerInGroup(groups: string[]): Promise<void>;
    notify(groups: string[], subject: string, message: string, fromEmail?: string, attachments?: EmailAttachment[], sendSingle?: boolean, maxTimeMinutes?: number): Promise<void>;
    getUserContext(): UserContext;
    getDocMgr(): any;
    accessDeniedError(): void;
    caller: PersonWithId;
    document: any;
    updates: any;
    isCreate() : boolean;
    isRead() : boolean;
    isUpdate() : boolean;
    isDelete() : boolean;
}

export interface DocState {
    label: string;
    description: string;

    entry?: StateCallback | string[];
    onEntry?: StateActionCallback;
    onReentry?: StateActionCallback;
    
    read?: StateCallback | string[];
    onRead?: StateActionCallback;
    onAfterRead?: StateActionCallback;
    
    write?: StateCallback | string[];
    onWrite?: StateActionCallback;

    commentWrite?: StateCallback | string[];
    commentReadPublic?: StateCallback | string[];
    commentReadPrivate?: StateCallback | string[];

    exit?: StateCallback | string[];
    onExit?: StateActionCallback;
    
    delete?: StateCallback | string[];
    onDelete?: StateActionCallback;
    
    action?: StateActionCallback;
    puml?: PumlState;
    nextStates: PossibleStates;
}

export interface DocStates  {
    [name: string]: DocState
}

export interface RoleEntry {
    name: string;
    getMembers: string | MemberListCallback;
}

export interface Roles {
    [name: string]: RoleEntry;
}

export interface NextState {
    groups: string[];
    label?: string;
    description?: string;
    puml?: PumlArc;
    action?: StateActionCallback;
    [key: string]: any;
}

export interface PossibleStates {
    [key:string]: NextState;
}

export interface CommentHistory {
    date: number;
    user: Person;
}

export interface CommentInfo {
    id: string;
    date: number;
    user: Person;
    topic: string;
    text: string;
    edited?: CommentHistory[];
    approved?: string;
    private?: boolean;
}

export interface CommentCreate {
    topic: string;
    text: string;
    private?: boolean;
    approved?: string;
}

export  interface CommentUpdate {
    topic?: string;
    text?: string;
    private?: boolean;
    approved?: string;
}

export interface StateHistory {
    state: string;
    date: number;
    email?: string;
}
