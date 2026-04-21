/**
 * Copyright (c) 2024 Discover Financial Services
 */
import { UserContext } from 'dlms-base';

export interface UserProfileService {
    get(claimsOrUid: any, details?: boolean): Promise<UserContext[]>;

    verify(uid: string, pwd: string): Promise<UserContext>;
}

/* eslint-disable @typescript-eslint/no-unused-vars */
export class DefaultUserProfileService {
    async get(claimsOrUid: any, details?: boolean): Promise<UserContext[]> {
        throw new Error('User profile service not implemented.');
    }

    async verify(uid: string, pwd: string): Promise<UserContext> {
        throw new Error('User profile service not implemented.');
    }
}
/* eslint-enable @typescript-eslint/no-unused-vars */
