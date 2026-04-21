/**
 * Copyright (c) 2024 Discover Financial Services
 */
import * as express from 'express';
import {
    Body,
    Controller,
    Get,
    Post,
    Put,
    Path,
    Route,
    Request,
    Query,
    Example,
    Response,
} from 'tsoa';
import { DocMgr } from '../docMgr';

@Route('/api/admin')
export class AdminController extends Controller {
    /**
     * Export all application data from DB.  For applications with a large number of documents, exportIds() with exportId() should be used.
     * @param req
     * @returns A single object, with collection names as properties, each with a value array containing all documents from the collection
     */
    @Example({
        collectionName1: [
            { key1: 'value1', key2: 'value2' },
            { key3: 'value3', key4: 'value4' },
        ],
        collectionName2: [
            { key5: 'value5', key6: 'value6' },
            { key7: 'value7', key8: 'value8' },
        ],
    })
    @Response('401', 'User is not an admin')
    @Response('500', 'Internal Server Error.  Check database connection')
    @Get('export')
    public async export(@Request() req: express.Request): Promise<any> {
        const mgr = DocMgr.getInstance();
        return mgr.export(mgr.getCtx(req));
    }

    /**
     * Export the ids of all documents from each collection in the DB.  Each document can then be exported using exportId().
     * @param req
     * @returns A single object, with collection names as properties, each with a value array containing the ids of all documents from the collection
     */
    @Example({
        collectionName1: ['id1', 'id2', '...'],
        collectionName2: ['id2', 'id3', '...'],
    })
    @Response('401', 'User is not an admin')
    @Response('500', 'Internal Server Error.  Check database connection')
    @Get('export_ids')
    public async exportIds(@Request() req: express.Request): Promise<any> {
        const mgr = DocMgr.getInstance();
        return mgr.exportIds(mgr.getCtx(req));
    }

    /**
     * Export a single document by its id from a specific collection.
     * @param req
     * @param collection Name of collection
     * @param id Document id
     * @returns Any object, requested document
     */
    @Example({ key1: 'value1', key2: 'value2' })
    @Response('401', 'User is not an admin')
    @Response('500', 'Internal Server Error.  Check database connection')
    @Get('export/{collection}/{id}')
    public async exportId(
        @Request() req: express.Request,
        @Path() collection: string,
        @Path() id: string
    ): Promise<any> {
        const mgr = DocMgr.getInstance();
        return mgr.exportId(mgr.getCtx(req), collection, id);
    }

    /**
     * Import a single document with the given id into a specific collection.
     * @param req
     * @param collection Name of collection
     * @param id Document id
     * @param body Any object, document to import
     * @returns Any object, document that was imported
     */
    @Example({ id: 'id', key1: 'value1', key2: 'value2' })
    @Response('401', 'User is not an admin')
    @Response('500', 'Internal Server Error.  Check database connection')
    @Put('import/{collection}/{id}')
    public async importId(
        @Request() req: express.Request,
        @Path() collection: string,
        @Path() id: string,
        @Body() body: any
    ): Promise<any> {
        const mgr = DocMgr.getInstance();
        return mgr.importId(mgr.getCtx(req), collection, id, body);
    }

    /**
     * Import data into collections based on the provided data.  If a document with the given id already exists in the specified collection, that document will be ignored and processing will continue.
     * @param req
     * @param body A single object, with collection names as properties, each with a value array containing all documents to add to the collection
     * @returns void
     */
    @Response('401', 'User is not an admin')
    @Response('500', 'Internal Server Error.  Check database connection')
    @Post('import')
    public async import(
        @Request() req: express.Request,
        @Body() body: any
    ): Promise<void> {
        const mgr = DocMgr.getInstance();
        return mgr.import(mgr.getCtx(req), body);
    }

    /**
     * Drops all documents from all collections, including user groups and then re-runs init.
     * @param req
     * @param simpleInit boolean.  If true, user groups specified in DocMgr constructor will NOT be rebuilt during re-init.
     * @returns void
     */
    @Response('401', 'User is not an admin')
    @Response('500', 'Internal Server Error.  Check database connection')
    @Get('reset')
    public async reset(
        @Request() req: express.Request,
        @Query() simpleInit: boolean = false
    ): Promise<void> {
        const mgr = DocMgr.getInstance();
        return mgr.reset(mgr.getCtx(req), simpleInit);
    }
}
