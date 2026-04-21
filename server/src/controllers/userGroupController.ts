/**
 * Copyright (c) 2024 Discover Financial Services
 */
import * as express from 'express';
import {
    Body,
    Controller,
    Get,
    Path,
    Put,
    Patch,
    Delete,
    Route,
    Request,
    Response,
    Example,
} from 'tsoa';
import { DocMgr } from '../docMgr';
import {
    UserGroupCreate,
    UserGroupUpdate,
    UserGroupInfo,
    UserGroupList,
} from 'dlms-base';

@Route('/api/user_groups')
export class UserGroupController extends Controller {
    /**
     * Retrieve information for all of the user groups
     * @param req
     * @returns UserGroupList object
     */
    @Example<UserGroupList>({
        count: 3,
        items: [
            { id: 'idGroup1', members: [], deletable: true },
            { id: 'idGroup2', members: [], deletable: true },
            { id: 'idGroup3', members: [], deletable: false },
        ],
    })
    @Response('500', 'Internal Server Error.  Check database connection')
    @Get()
    public async getUserGroups(): Promise<UserGroupList> {
        const mgr = await DocMgr.getInstance();
        return await mgr.getUserGroups();
    }

    /**
     * Retrieve information for given user group
     * @param req
     * @param id Document id
     * @returns UserGroupInfo object
     */
    @Example<UserGroupInfo>({ id: 'idGroup1', members: [], deletable: true })
    @Response('404', 'User group does not exist')
    @Response('500', 'Internal Server Error.  Check database connection')
    @Get('{id}')
    public async getUserGroup(
        @Request() req: express.Request,
        @Path() id: string
    ): Promise<UserGroupInfo> {
        const mgr = await DocMgr.getInstance();
        return await mgr.getUserGroup(mgr.getCtx(req), id);
    }

    /**
     * Create user group.  User must be an admin to create a
     * user group.
     * @param req
     * @param body UserGroupCreate object
     * @returns New UserGroupInfo object retrieved from DB
     */
    @Example<UserGroupInfo>({ id: 'idGroup1', members: [], deletable: true })
    @Response('400', 'User group with given id already exists')
    @Response('401', 'User not an admin')
    @Response('500', 'Internal Server Error.  Check database connection')
    @Put()
    public async createUserGroup(
        @Request() req: express.Request,
        @Body() body: UserGroupCreate
    ): Promise<UserGroupInfo> {
        const mgr = await DocMgr.getInstance();
        return await mgr.createUserGroup(mgr.getCtx(req), body);
    }

    /**
     * Update the given user group.  User must be an admin
     * to update a user group.
     * @param req
     * @param id User group id
     * @param args UserGroupUpdate object
     * @returns Updated UserGroupInfo object retrieved from DB
     */
    @Example<UserGroupInfo>({ id: 'idGroup1', members: [], deletable: true })
    @Response('401', 'User not an admin')
    @Response('404', 'User group with given id not found')
    @Response('500', 'Internal Server Error.  Check database connection')
    @Patch('{id}')
    public async updateUserGroup(
        @Request() req: express.Request,
        @Path() id: string,
        @Body() args: UserGroupUpdate
    ): Promise<UserGroupInfo> {
        const mgr = await DocMgr.getInstance();
        return await mgr.updateUserGroup(mgr.getCtx(req), id, args);
    }

    /**
     * Delete the given user group.  User must be an admin
     * to delete a user group.
     * @param req
     * @param id User group id
     * @returns UserGroupInfo object that was deleted
     */
    @Example<UserGroupInfo>({ id: 'idGroup1', members: [], deletable: true })
    @Response('401', 'User not an admin')
    @Response('403', 'User group is marked undeleteable')
    @Response('404', 'User group with given id not found')
    @Response('500', 'Internal Server Error.  Check database connection')
    @Delete('{id}')
    public async deleteUserGroup(
        @Request() req: express.Request,
        @Path() id: string
    ): Promise<UserGroupInfo> {
        const mgr = await DocMgr.getInstance();
        return await mgr.deleteUserGroup(mgr.getCtx(req), id);
    }
}
