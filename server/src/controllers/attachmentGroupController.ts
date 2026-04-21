/**
 * Copyright (c) 2024 Discover Financial Services
 */
import * as express from 'express';
import { Readable } from 'stream';
import crypto from 'crypto';
import {
    Controller,
    Get,
    Path,
    Put,
    Delete,
    Route,
    Request,
    UploadedFile,
    Response,
    Example,
} from 'tsoa';
import { DocMgr, AttachmentModel, AttachmentModelCreate } from '../docMgr';
import { AttachmentInfo, DocList } from 'dlms-base';
import { Logger } from '../logger';
import { Config } from '../config';
const cfg = new Config();
const log = new Logger('agc');

@Route('/api/docs')
export class AttachmentGroupController extends Controller {
    private toAttachmentInfo(model: AttachmentModel): AttachmentInfo {
        const r: AttachmentInfo = {
            id: model._id,
            hash: model.hash,
            collection: model.collection,
            doc: model.doc,
            name: model.name,
            size: model.size,
            date: model.date,
            type: model.type,
            url: `${cfg.baseUrl}/api/docs/${model.collection}/${model.doc}/attachments/${model._id}/`,
        };
        return r;
    }

    /**
     * Retrieve every attachment in the attachments collection
     * @param req
     * @returns DocList object
     */
    @Example<DocList>({
        count: 3,
        items: [
            { key3: 'value3', key4: 'value4' },
            { key5: 'value5', key6: 'value6' },
            { key7: 'value7', key8: 'value8' },
        ],
    })
    @Response('500', 'Internal Server Error.  Check database connection')
    @Get('attachments')
    public async getAttachments(@Request() req: express.Request): Promise<any> {
        const mgr = DocMgr.getInstance();
        const result = await mgr.getAttachments(mgr.getCtx(req));
        const r = [];
        for (const element of result) {
            r.push(this.toAttachmentInfo(element));
        }
        return {
            count: r.length,
            items: r,
        };
    }

    /**
     * Retrieve every attachment associated with the given document
     * in the given collection.  User must have read access to this
     * document in its current state in order to retrieve the attachments.
     * @param req
     * @param collection Collection name
     * @param docId Document id
     * @returns object
     */
    @Example<DocList>({
        count: 3,
        items: [
            { key3: 'value3', key4: 'value4' },
            { key5: 'value5', key6: 'value6' },
            { key7: 'value7', key8: 'value8' },
        ],
    })
    @Response('401', 'User has no read access')
    @Response('404', 'Document does not exist')
    @Response('500', 'Internal Server Error.  Check database connection')
    @Get('{collection}/{docId}/attachments')
    public async getDocAttachments(
        @Request() req: express.Request,
        @Path() collection: string,
        @Path() docId: string
    ): Promise<any> {
        const mgr = DocMgr.getInstance();
        mgr.getDoc(mgr.getCtx(req), {
            type: collection,
            id: docId,
        }); // Check to make sure user has read access to doc
        const result = await mgr.getAttachments(mgr.getCtx(req), {
            match: { doc: docId },
        });
        const r = [];
        for (let i = 0; i < result.length; i++) {
            r.push(this.toAttachmentInfo(result[i]));
        }
        return {
            count: r.length,
            items: r,
        };
    }

    /**
     * Retrieve the given attachment associated with the given document
     * in the given collection.  User must have read access to this document
     * in its current state in order to retrieve the attachment.
     * @param req
     * @param collection Collection name
     * @param docId Document id
     * @param attachmentId Attachment id
     * @returns Readable object
     */
    @Example<DocList>({
        count: 3,
        items: [
            { key3: 'value3', key4: 'value4' },
            { key5: 'value5', key6: 'value6' },
            { key7: 'value7', key8: 'value8' },
        ],
    })
    @Response('401', 'User has no read access')
    @Response('404', 'Document does not exist')
    @Response('500', 'Internal Server Error.  Check database connection')
    @Get('{collection}/{docId}/attachments/{attachmentId}')
    public async getDocAttachment(
        @Request() req: express.Request,
        @Path() collection: string,
        @Path() docId: string,
        @Path() attachmentId: string
    ): Promise<any> {
        const mgr = await DocMgr.getInstance();
        try {
            const res = req.res;
            mgr.getDoc(mgr.getCtx(req), {
                type: collection,
                id: docId,
            }); // Check to make sure user has read access to doc
            const r = await mgr.getAttachment(mgr.getCtx(req), attachmentId);
            if (r != null && res) {
                res.setHeader('Content-Type', r.type);
                res.write(r.data.buffer);
                res.end();
            }
        } catch (e) {
            log.debug(`Error getting document - returning 404: `, e);
        }
        this.setStatus(404);
    }

    /**
     * Delete the given attachment associated with the given document
     * in the given collection.  User must have read and write access
     * to this document in its current state in order to delete the
     * attachment.
     * @param req
     * @param collection Collection name
     * @param docId Document id
     * @param attachmentId Attachment id
     * @returns Updated array of AttachmentInfo objects for the file
     */
    @Example<AttachmentInfo[]>([
        {
            id: '32343234',
            hash: '123445567',
            name: 'MyFile',
            size: 3456789,
            date: 14182940000,
            type: 'MyFileType',
            url: 'https://example.com/file/342321432',
        },
    ])
    @Response('401', 'User has no read access')
    @Response('404', 'Document does not exist')
    @Response('500', 'Internal Server Error.  Check database connection')
    @Delete('{collection}/{docId}/attachments/{attachmentId}')
    public async deleteDocAttachments(
        @Request() req: express.Request,
        @Path() collection: string,
        @Path() docId: string,
        @Path() attachmentId: string
    ): Promise<any> {
        const mgr = DocMgr.getInstance();
        const ctx = mgr.getCtx(req);
        try {
            const attachment = await mgr.getAttachment(ctx, attachmentId);
            await mgr.deleteAttachment(ctx, attachment._id);
        } catch (e) {
            log.info("Attachment wasn't found");
        }
        const ds = { type: collection, id: docId };
        const doc = await mgr.getDoc(ctx, ds);
        const attachments = doc.attachments || [];
        for (let i = 0; i < attachments.length; i++) {
            if (attachments[i].id == attachmentId) {
                attachments.splice(i, 1);
                mgr.updateDoc(ctx, ds, { attachments: attachments });
                return attachments;
            }
        }
        this.setStatus(404);
    }

    /**
     * Associate a file with the given document in the given collection.
     * User must have read and write access to this document in its current
     * state.  If no attachment with the same name exists, a new attachment
     * is created.  If the name exists but the file is different, the
     * existing attachment is updated.  If the name exists and the file
     * is the same, no action is taken.
     * @param req
     * @param collection Collection name
     * @param docId Document id
     * @param file Express.multer.file
     * @returns Array of the AttachmentInfo objects for the file
     */
    @Example<AttachmentInfo[]>([
        {
            id: '32343234',
            hash: '123445567',
            name: 'MyFile',
            size: 3456789,
            date: 14182940000,
            type: 'MyFileType',
            url: 'https://example.com/file/342321432',
        },
    ])
    @Response('401', 'User access denied')
    @Response('500', 'Internal Server Error.  Check database connection')
    @Put('{collection}/{docId}/attachments/')
    public async createDocAttachments(
        @Request() req: express.Request,
        @Path() collection: string,
        @Path() docId: string,
        @UploadedFile() file: Express.Multer.File
    ): Promise<any> {
        log.debug(`createDocAttachments doc=${docId})`);
        //log.debug("file=" + JSON.stringify(file));
        const hashSum = crypto.createHash('sha256');
        hashSum.update(file.buffer);
        const hash = hashSum.digest('hex');
        log.debug('hash=' + hash);
        const mgr = DocMgr.getInstance();
        const ctx = mgr.getCtx(req);
        const ds = { type: collection, id: docId };
        const doc = await mgr.getDoc(ctx, ds);
        const attachments = doc.attachments || [];
        if (attachments.length > 0) {
            for (let i = 0; i < attachments.length; i++) {
                if (attachments[i].name == file.originalname) {
                    if (attachments[i].hash == hash) {
                        log.debug('Uploaded identical file');
                        return attachments;
                    }
                    const r2 = await mgr.updateAttachment(
                        ctx,
                        attachments[i].id,
                        {
                            hash: hash,
                            size: file.buffer.length,
                            date: Date.now(),
                            data: file.buffer,
                        }
                    );
                    const ai: AttachmentInfo = {
                        ...attachments[i],
                        hash: r2.hash,
                        size: r2.size,
                        date: r2.date,
                    };
                    attachments[i] = ai;
                    log.debug('Updated attachment:', ai);
                    await mgr.updateDoc(ctx, ds, { attachments: attachments });
                    return attachments;
                }
            }
        }

        const args: AttachmentModelCreate = {
            collection: collection,
            doc: docId,
            hash: hash,
            name: file.originalname,
            size: file.buffer.length,
            date: Date.now(),
            type: file.mimetype,
            data: file.buffer,
        };
        const r = await mgr.createAttachment(ctx, args);

        const attachment: AttachmentInfo = {
            id: r._id,
            hash: hash,
            name: file.originalname,
            size: file.buffer.length,
            date: Date.now(),
            type: file.mimetype,
            url: `${cfg.baseUrl}/api/docs/${collection}/${docId}/attachments/${r._id}/`,
        };
        attachments.push(attachment);
        await mgr.updateDoc(ctx, ds, { attachments: attachments });
        return attachments;
    }
}
