/**
 * Copyright (c) 2024 Discover Financial Services
 */
import * as express from 'express';
import {
    Body,
    Controller,
    Path,
    Post,
    Request,
    Route,
    Response,
    Example,
} from 'tsoa';
import { DocMgr } from '../docMgr';

@Route('/api/action/{type}/{id}')
export class ActionController extends Controller {
    /**
     * Invoke the action associated with the document of the given collection with the given id.  The action invoked is determined by the document's current state.
     * @param req
     * @param type Collection name
     * @param id Document id
     * @param body Any object, arguments to the action function
     * @returns Any object returned by action, undefined if action not defined
     */
    @Example({ key1: 'value1', key2: 'value2' })
    @Response('404', 'Document :id was not found')
    @Response('500', 'Internal Server Error.  Check database connection')
    @Post()
    public async runActionForDoc(
        @Request() req: express.Request,
        @Path() type: string,
        @Path() id: string,
        @Body() body: any
    ): Promise<any> {
        const mgr = DocMgr.getInstance();
        return mgr.runActionForDoc(mgr.getCtx(req), { type, id }, body);
    }
}
