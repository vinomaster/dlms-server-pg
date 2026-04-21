/**
 * Copyright (c) 2024 Discover Financial Services
 */
import {
    UserContext,
    DocState,
    DocStates,
    StateCallbackContext,
    StateCallbackReturn,
} from 'dlms-base';
import { Logger } from './logger';
import { DocMgr, DocSpec } from './docMgr';
import { DocMgrError } from './util';

const log = new Logger('test');

async function main() {
    // Create all user contexts
    const admin1 = createUserContextAdmin('admin1');
    const manager1 = createUserContext('manager1');
    const procurement1 = createUserContext('procurement1');
    const user1 = createUserContext('user1');
    const user2 = createUserContext('user2');
    // Get the document manager instance and reset back to original state
    const docType = 'testDocType';
    const dm = new DocMgr({
        appName: 'test',
        documents: {
            profile: {
                document_id_required: true,
                states: {
                    created: {
                        label: 'Created',
                        description: 'Created',
                        entry: profileACL,
                        read: profileACL,
                        write: profileACL,
                        nextStates: {},
                    },
                },
            },
            testDocType: {
                states: getTestStates(),
            },
        },
        userGroups: [{ id: 'management' }, { id: 'procurement' }],
        adminGroups: ['admin'],
        adminRole: 'Admin',
        roles: ['Admin'],
        email: '',
    });
    DocMgr.setInstance(dm);
    await dm.reset(admin1);
    // Try to create usergroup as user1.  This should fail.  Only admins can create usergroup.
    try {
        const usergroup = await dm.createUserGroup(user1, {
            id: 'NonExistentUserGroup',
            members: [user1.user],
            deletable: true,
        });
        myAssert(!usergroup, 'Unexpected user group created');
    } catch (error) {
        const dmError = error as DocMgrError;
        myAssert(
            dmError.scode === 401,
            `Unexpected error ${error} from createUserGroup`
        );
    }
    // Try to Add manager1 to non-existent user group.  This should fail
    try {
        await dm.updateUserGroup(admin1, 'NonExistentUserGroup', {
            members: [manager1.user],
        });
    } catch (error) {
        const dmError = error as DocMgrError;
        myAssert(
            dmError.scode === 404,
            `Unexpected error ${error} from updateUserGroup`
        );
    }
    // Add manager1 to list of managers
    await dm.updateUserGroup(admin1, 'management', {
        members: [manager1.user],
    });
    // User1 creates a doc
    const doc1: any = await dm.createDoc(user1, docType, {
        requestors: [user1.user],
        approvers: [manager1.user],
        purchase: 'video monitor',
        state: 'requested',
    });
    log.info(`Created doc1: ${doc1.id}`);
    // User2 creates a doc
    const doc2 = await dm.createDoc(user2, docType, {
        requestors: [user2.user],
        purchase: 'software license',
        state: 'requested',
    });
    log.info(`Created doc2: ${doc2.id}`);
    // Make sure user1 only sees his documents and not that of user2
    //let dl = await dm.getDocs(user1, docType, ["inventors"]);
    //assertOneDoc(dl, doc1.id);

    // user sets procurement
    const ds: DocSpec = { type: docType, id: doc1.id };
    log.info(`User sets procurement list for doc1 ${doc1.id}`);
    let pi = await dm.updateDoc(user1, ds, {
        procurement: [procurement1.user],
    });
    log.info(`Updated doc1 to ${JSON.stringify(pi, null, 4)}`);
    // Make sure that document state can be updated by management
    const approvedState = 'approved';
    log.info(`Management sets status to ${approvedState} for doc1 ${doc1.id}`);
    pi = await dm.updateDoc(manager1, ds, { state: approvedState });
    log.info(`Updated state document 1 to ${JSON.stringify(pi, null, 4)}`);

    // Try to update document as user that created it.  This should fail to update due to
    //  "closed" DocState write property requiring updater to be part of the
    //  "procurement" property on the document
    const closedState = 'closed';
    log.info(`User sets status to ${closedState} for doc1 ${doc1.id}`);
    try {
        const updatedDoc1 = await dm.updateDoc(user1, ds, {
            state: closedState,
        });
        myAssert(
            updatedDoc1.state !== 'closed',
            'Doc1 should not have been updated but it was'
        );
    } catch (e) {}
    // The procurement1 user should see exactly one doc now: doc1
    log.info(`Procurement views doc1 ${doc1.id}`);
    //dl = await dm.getDocs(iec1, docType, ["procurement"]);
    //assertOneDoc(dl, doc1.id);

    // Create the doc by id
    log.info(`Creating profile1`);
    const uid = user1.user.id;
    let p1 = await dm.createDocById(user1, 'profile', 'user1', {
        id: uid,
        addr: 'user1 address',
    });
    log.info(`Created profile1: ${JSON.stringify(p1)}`);
    myAssert(
        p1.id === uid,
        `Expecting doc id of '${uid}' but found '${p1.id}'`
    );

    p1 = await dm.getDoc(user1, { id: uid, type: 'profile' });
    log.info(`Found profile1: ${JSON.stringify(p1)}`);
    myAssert(
        p1.id === uid,
        `Expecting doc id of '${uid}' but found '${p1.id}'`
    );

    // Export, reset, and import
    const exported = await dm.export(admin1);
    await dm.reset(admin1);
    await dm.import(admin1, exported);
    // Done
    log.debug('Passed');
    process.exit(0);
}

//function assertOneDoc(dl: any, id: string) {
//    myAssert(
//        dl.length === 1,
//        `Length of document list is ${dl.length}: ${JSON.stringify(dl)}`
//    );
//    myAssert(
//        dl[0].id === id,
//        `Invalid document returned; expecting ${id} but found ${dl[0].id}`
//    );
//}

function createUserContext(id: string): UserContext {
    return {
        user: {
            id,
            name: id,
            department: id,
            email: `${id}@test.com`,
            roles: ['Employee'],
            title: 'chief flunky',
            employeeNumber: id,
        },
    };
}

function createUserContextAdmin(id: string): UserContext {
    return {
        user: {
            id,
            name: id,
            department: id,
            email: `${id}@test.com`,
            isAdmin: true,
            roles: ['Employee', 'Admin'],
            title: 'chief flunky',
            employeeNumber: id,
        },
    };
}

function myAssert(pass: boolean, err: string) {
    if (!pass) {
        throw Error(err);
    }
}

async function profileACL(
    scc: StateCallbackContext
): Promise<StateCallbackReturn> {
    // If the caller's name isn't equal to the ID of the document, access is denied
    const docId = scc.document.id;
    const uid = scc.caller.id;
    if (uid !== docId) {
        console.log(
            `ACCESS ERROR: user '${uid}' can't access profile document ${JSON.stringify(docId)}`
        );
        return { groups: [] };
    }
    return { groups: ['Employee'] };
}

function getTestStates(): DocStates {
    const states: { [name: string]: DocState } = {};
    states['requested'] = {
        label: 'Requested',
        description: 'Requested',
        read: ['Employee', 'procurement', 'management'],
        write: ['Employee'],
        nextStates: {
            approved: { groups: ['management'], label: '', description: '' },
            closed: { groups: ['procurement'], label: '', description: '' },
        },
    };
    states['approved'] = {
        label: 'Approved',
        description: 'Approved',
        read: ['Employee', 'procurement', 'management'],
        write: ['management'],
        nextStates: {
            purchased: { groups: ['procurement'], label: '', description: '' },
            closed: { groups: ['procurement'], label: '', description: '' },
        },
    };
    states['purchased'] = {
        label: 'Purchased',
        description: 'Purchased',
        read: ['Employee', 'procurement', 'management'],
        write: ['procurement'],
        nextStates: {
            closed: { groups: ['procurement'], label: '', description: '' },
        },
    };
    states['closed'] = {
        label: 'Closed',
        description: 'Closed',
        read: ['Employee', 'procurement', 'management'],
        write: ['procurement'],
        nextStates: {},
    };
    return states;
}

main();
