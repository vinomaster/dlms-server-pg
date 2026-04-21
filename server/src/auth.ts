/**
 * Copyright (c) 2024 Discover Financial Services
 */
import { UserContext } from 'dlms-base';
import { Logger } from './logger';
import { DocMgr } from './docMgr';
import { UserProfileService } from './userProfileService';
import { throwErr } from './err';

const log = new Logger('dlms-auth');
export const sessionCookieName = 'dlms.session';

interface CacheEntry {
    time: number;
    ctx: UserContext;
}

const emailToUserContextCache: { [email: string]: CacheEntry } = {};

/**
 * Retrieves the user context from the claims and the user profile service.
 *
 * @param {any} claims - The claims object containing user information.
 * @param {UserProfileService} userProfileService - The user profile service used to retrieve the user context.
 * @returns {Promise<UserContext>} The user context retrieved from the claims.
 *
 * @throws {Error} Throws an error with status code 500 if getting the profile fails.
 */
export async function getUserContextFromClaims(
    claims: any,
    userProfileService: UserProfileService
): Promise<UserContext> {
    log.debug(`getUserContextFromClaims: claims=`, claims);
    const email = claims.email;
    const cachedCtx = emailToUserContextCache[email];

    // Check if the user context is cached and the cache is less than 60 seconds old
    if (cachedCtx && Date.now() - cachedCtx.time < 60000) {
        return cachedCtx.ctx;
    }
    try {
        // Fetch the user context from the user profile service
        const ctxs = await userProfileService.get(claims);
        const ctx = ctxs[0];
        // Cache the fetched user context
        emailToUserContextCache[email] = { time: Date.now(), ctx };
        return ctx;
    } catch (e) {
        log.err('Error getting profile: ', e);
        // Throw an error with status code 500 if there is an error while fetching the user context
        throwErr(500, 'Get profile failed - try again later.');
    }
}

/**
 * Logs in a user with the provided credentials.
 *
 * @param uid - The user id of the user trying to login.
 * @param pwd - The password of the user trying to login.
 * @param userProfileService - The service that handles user profile related operations.
 * @returns A promise that resolves to the context of the logged in user.
 */
export async function loginUser(
    uid: string,
    pwd: string,
    userProfileService: UserProfileService
): Promise<UserContext> {
    log.debug(`loginUser(${uid})`);

    // Get the admin email and password from the environment variables.
    let adminEmailPw: any = process.env[`DLMS_ADMIN_${uid}`];

    // If the user id is "admin" and there is no admin email and password in the environment variables, use the default admin credentials.
    if (!adminEmailPw && uid == 'admin') {
        adminEmailPw = process.env['ADMIN'];
    }

    // If there are admin credentials, proceed with the admin login process.
    if (adminEmailPw) {
        log.debug(`loginUser(${uid}) matches DLMS_ADMIN_${uid} or ADMIN`);

        // Split the admin credentials into email and password.
        const parts = adminEmailPw.split(':');
        let email = '';
        let pass = adminEmailPw;
        if (parts.length == 2) {
            email = parts[0];
            pass = parts[1];
        }

        // If the password does not match, throw an error.
        if (pass !== pwd) {
            log.err(' -- Error basic authentication of admin');
            throwErr(401, 'basic authentication failure (2)');
        }

        // Get the instance of the document manager.
        const dm = DocMgr.getInstance();

        // Create the user context for the admin user.
        const ctx: UserContext = {
            user: {
                id: uid,
                name: uid,
                roles: [dm.getAdminRole()],
                department: '',
                email: email,
                title: 'admin',
                employeeNumber: '',
            },
        };
        log.debug(' -- context of admin = ', ctx);

        // Return the user context.
        return ctx;
    }

    // Get the API token from the environment variables.
    const apiToken =
        process.env['API_TOKEN'] || process.env['DLMS_ADMIN_admin'];

    // If there is an API token and the password matches the API token, get the user context for the user.
    if (apiToken && pwd === apiToken && uid) {
        log.debug('loginUser matches API_TOKEN, so get context for user');
        const ctxs = await userProfileService.get(uid);
        return ctxs[0];
    }

    // If the user id and password have been passed, verify the user.
    log.debug('loginUser has been passed uid & pwd, so verify user');
    const ctx = await userProfileService.verify(uid, pwd);

    // Return the user context.
    return ctx;
}
