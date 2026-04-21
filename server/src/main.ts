/**
 * Copyright (c) 2024 Discover Financial Services
 */
import { DocMgr } from './docMgr';
import { Server } from './server';
import { StateCallbackContext, StateCallbackReturn } from 'dlms-base';

function usage(msg?: string) {
    if (msg) {
        console.log(`Error: ${msg}`);
    }
    console.log(`Usage: serve`);
    process.exit(1);
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length == 0) {
        usage();
    }
    const cmd = args[0];
    if (cmd === 'serve') {
        const docMgr = new DocMgr({
            appName: 'main',
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
            },
            userGroups: [],
            adminGroups: [],
            adminRole: 'Admin',
            roles: ['Admin'],
            email: '',
        });
        DocMgr.setInstance(docMgr);
        await Server.run(docMgr);
    } else {
        usage(`invalid command: '${cmd}'`);
    }
}

/**
 * Retrieve groups if access is allowed
 *
 * @param scc
 * @returns Empty group object
 */
async function profileACL(
    scc: StateCallbackContext
): Promise<StateCallbackReturn> {
    // If the caller's name isn't equal to the ID of the document, access is denied
    const docId = scc.document.id;
    const uid = scc.caller.id;
    if (uid !== docId) {
        console.log(
            `ACCESS ERROR: user '${uid}' can't access profile document ${docId}`
        );
        scc.accessDeniedError();
    }
    return { groups: [] };
}

main();
