/**
 * Copyright (c) 2024 Discover Financial Services
 */
import * as express from 'express';
import {
    Body,
    Controller,
    Get,
    Path,
    Post,
    Put,
    Patch,
    Delete,
    Query,
    Request,
    Route,
    Response,
    Example,
} from 'tsoa';
import { DocMgr, PostDocs } from '../docMgr';
import { CommentCreate, CommentInfo, CommentUpdate, DocList } from 'dlms-base';
@Route('/api/docs/{type}')
export class DocController extends Controller {
    /**
     * Create a document in the given collection.  User must have access
     * to create documents of the given type.
     * @param req
     * @param type DocType name
     * @param body Any object
     * @returns Newly created document retrieved from the DB
     */
    @Example<object>({ key1: 'value1', key2: 'value2', key3: 'value3' })
    @Response('401', 'User access denied')
    @Response(
        '401',
        'If documents of the given type are required to have an id and none was provided'
    )
    @Response('500', 'Internal Server Error.  Check database connection')
    @Response('422', 'Validation Error')
    @Put()
    public async createDoc(
        @Request() req: express.Request,
        @Path() type: string,
        @Body() body: any
    ): Promise<any> {
        const mgr = DocMgr.getInstance();
        const dt = mgr.getDocType(type);
        if (dt.validate?.createDoc) {
            dt.validate.createDoc(type, body);
        }
        return mgr.createDoc(mgr.getCtx(req), type, body);
    }

    /**
     * Create a document in the given collection with the
     * given unique id.  User must have access to create
     * documents of the given type.
     * @param req
     * @param type DocType name
     * @param id Document id
     * @param body Any object
     * @returns Newly created document retrieved from the DB
     */
    @Example<object>({ id: 'idValue', key1: 'value1', key2: 'value2', key3: 'value3' })
    @Response('401', 'User access denied')
    @Response(
        '401',
        'If documents of the given type are required to have an id and none was provided'
    )
    @Response('500', 'Internal Server Error.  Check database connection')
    @Response('422', 'Validation Error')
    @Put('{id}')
    public async createDocById(
        @Request() req: express.Request,
        @Path() type: string,
        @Path() id: string,
        @Body() body: any
    ): Promise<any> {
        const mgr = DocMgr.getInstance();
        const dt = mgr.getDocType(type);
        if (dt.validate?.createDocById) {
            dt.validate.createDocById(type, id, body);
        }
        return mgr.createDocById(mgr.getCtx(req), type, id, body);
    }

    /**
     * Retrieve documents of the given type that satisfy the
     * given match.  User must have access to read documents
     * of the given type.
     * @param req
     * @param type DocType name
     * @param body PostDocs 
     * @returns DocList object or iterator id
     */
        @Example<object>({ stream: true, params: {match: 'query', projection: 'projection' }})
        @Response('401', 'User access denied')
        @Response(
            '401',
            'If documents of the given type are required to have an id and none was provided'
        )
        @Response('500', 'Internal Server Error.  Check database connection')
        @Response('422', 'Validation Error')
        @Post()
        public async postDocs(
            @Request() req: express.Request,
            @Path() type: string,
            @Body() body: PostDocs,
        ): Promise<any> {
            const mgr = DocMgr.getInstance();
            const dt = mgr.getDocType(type);
            if (dt.validate?.postDocs) {
                dt.validate.postDocs(type, body);
            }
            const res = (req.res as any) as express.Response;
            console.log(`POST ${type}: body=`, body);

            const match = body.params?.match || undefined;
            const projection = body.params?.projection || undefined;
            const options = body.params?.options || (projection ? {projection: projection} : undefined);
            const stream = body.stream;
            console.log("match=", match, "options=", options, "stream=", stream)
            if (stream) {
                if (stream === "iterator") {
                    const iteratorId = await mgr.getDocs(mgr.getCtx(req), type, match, options, stream);
                    res.write(iteratorId);
                    res.end();
                    return;
                }
                await mgr.getDocs(mgr.getCtx(req), type, match, options, stream, res);
            }
            else {
              const result = await mgr.getDocs(mgr.getCtx(req), type, match, options);
              const res:any = req.res;
              const len:any = result.length;
              res.write(`{"count":${len},"items":[`);
              if (len == 0) {
              }
              else {
                for (var i=0; i<len; i++) {
                  res.write(JSON.stringify(result[i]));
                  if (i < len-1) {
                    res.write(',')
                  }
                }
              }
              res.write(`]}`)      
              res.end();
            }
        }
    
    /**
     * Retrieve documents of the given type that satisfy the
     * given match.  User must have access to read documents
     * of the given type.
     * @param req
     * @param type DocType name
     * @param match Optional, stringified JSON, specifies selection filter using query operators.
     * @param options Optional, stringified JSON, specifies the query options (projection, sort, limit).
     * @returns DocList object or iterator id
     */
    @Example<DocList>({
        count: 3,
        items: [
            { key3: 'value3', key4: 'value4' },
            { key5: 'value5', key6: 'value6' },
            { key7: 'value7', key8: 'value8' },
        ],
    })
    @Response('401', 'User access denied')
    @Response('500', 'Internal Server Error.  Check database connection')
    @Response('422', 'Validation Error')
    @Get()
    public async getDocs(
        @Request() req: express.Request,
        @Path() type: string,
        @Query() match?: string,
        @Query() options?: string,
        @Query() stream?: string,
    ): Promise<any> {
        const mgr = DocMgr.getInstance();
        const dt = mgr.getDocType(type);
        if (dt.validate?.getDocs) {
            dt.validate.getDocs(type, match, options, stream);
        }
        const result = await mgr.getDocs(
            mgr.getCtx(req),
            type,
            match,
            options,
            stream
        );
        const rtn: any = {
            count: result.length,
            items: result,
        };
        return rtn;
    }

    /**
     * Retrieve the given document of the given type.  User
     * must have read access to this document in its current
     * state in order to retrieve it.
     * @param req
     * @param type DocType name
     * @param id Document id
     * @returns Document retrieved from DB
     */
    @Example<object>({ id: 'idValue', key3: 'value3', key4: 'value4' })
    @Response('401', 'User access denied')
    @Response('404', 'Document does not exist')
    @Response('500', 'Internal Server Error.  Check database connection')
    @Response('422', 'Validation Error')
    @Get('{id}')
    public async getDoc(
        @Request() req: express.Request,
        @Path() type: string,
        @Path() id: string
    ): Promise<any> {
        const mgr = DocMgr.getInstance();
        const dt = mgr.getDocType(type);
        if (dt.validate?.getDoc) {
            dt.validate.getDoc(type, id);
        }
        return mgr.getDoc(mgr.getCtx(req), { type, id });
    }

    /**
     * Update a document with the given id that lives in the
     * collection associated with the given DocType.  User
     * must have write access to update documents of the given
     * type.  If the update is a state change, user must be
     * authorized to change current state.
     * @param req
     * @param type DocType name
     * @param id Document id
     * @param args Any object with new property values to change
     * @returns Updated document retrieved from DB
     */
    @Example<object>({ id: 'idValue', key3: 'value3', key4: 'value4' })
    @Response('401', 'User access denied')
    @Response('404', 'Document does not exist')
    @Response('500', 'Internal Server Error.  Check database connection')
    @Response('422', 'Validation Error')
    @Patch('{id}')
    public async updateDoc(
        @Request() req: express.Request,
        @Path() type: string,
        @Path() id: string,
        @Body() args: any
    ): Promise<any> {
        const mgr = DocMgr.getInstance();
        const dt = mgr.getDocType(type);
        if (dt.validate?.updateDoc) {
            dt.validate.updateDoc(type, id, args);
        }
        return mgr.updateDoc(mgr.getCtx(req), { type, id }, args);
    }

    /**
     * Delete documents of the given type that satisfy the
     * given match from the collection associated
     * with the given DocType.  User must have read and write
     * access to the documents in its current state in order to
     * delete the document.
     * @param req
     * @param type DocType name
     * @param match Optional, stringified JSON, specifies selection filter using query operators.
     * @returns Documents that were deleted
     */
    @Example<object>({ id: 'idValue', key3: 'value3', key4: 'value4' })
    @Response('401', 'User access denied')
    @Response('500', 'Internal Server Error.  Check database connection')
    @Response('422', 'Validation Error')
    @Delete()
    public async deleteMany(
        @Request() req: express.Request,
        @Path() type: string,
        @Query() match: string,
        @Query() preview?: boolean,
    ): Promise<any> {
        const mgr = DocMgr.getInstance();
        const dt = mgr.getDocType(type);
        if (dt.validate?.deleteMany) {
            dt.validate.deleteMany(type, match, preview);
        }
        return mgr.deleteMany(mgr.getCtx(req), type, match, preview);
    }

    /**
     * Delete the given document from the collection associated
     * with the given DocType.  User must have read and write
     * access to this document in its current state in order to
     * delete the document.
     * @param req
     * @param type DocType name
     * @param id Document id
     * @returns Document that was deleted
     */
    @Example<object>({ id: 'idValue', key3: 'value3', key4: 'value4' })
    @Response('401', 'User access denied')
    @Response('404', 'Document does not exist')
    @Response('500', 'Internal Server Error.  Check database connection')
    @Response('422', 'Validation Error')
    @Delete('{id}')
    public async deleteDoc(
        @Request() req: express.Request,
        @Path() type: string,
        @Path() id: string
    ): Promise<any> {
        const mgr = DocMgr.getInstance();
        const dt = mgr.getDocType(type);
        if (dt.validate?.deleteDoc) {
            dt.validate.deleteDoc(type, id);
        }
        return mgr.deleteDoc(mgr.getCtx(req), { type, id });
    }

    @Put("{id}/comment")
    @Response('401', 'User access denied')
    @Response('404', 'Document does not exist')
    @Response('500', 'Internal Server Error.  Check database connection')
    @Response('422', 'Validation Error')
    public async addComment(
        @Request() req: express.Request, 
        @Path() type: string,
        @Path() id: string, 
        @Body() args: CommentCreate
    ): Promise<any> {
      console.log(`addComment(${id})`);
      const mgr = DocMgr.getInstance();
      const dt = mgr.getDocType(type);
      if (dt.validate?.addComment) {
          dt.validate.addComment(type, id, args);
      }
    return mgr.addComment(mgr.getCtx(req), { type, id }, args);
    }
  
    @Get("{id}/comment/{cid}")
    @Response('401', 'User access denied')
    @Response('404', 'Document does not exist')
    @Response('500', 'Internal Server Error.  Check database connection')
    @Response('422', 'Validation Error')
    public async getComment(
        @Request() req: express.Request, 
        @Path() type: string,
        @Path() id: string, 
        @Path() cid: string
    ): Promise<CommentInfo> {
      console.log(`getComment(${id}, ${cid})`);
      const mgr = DocMgr.getInstance();
      const dt = mgr.getDocType(type);
      if (dt.validate?.getComment) {
          dt.validate.getComment(type, id, cid);
      }
      return mgr.getComment(mgr.getCtx(req), { type, id }, cid);
    }
  
    @Patch("{id}/comment/{cid}")
    @Response('401', 'User access denied')
    @Response('404', 'Document does not exist')
    @Response('500', 'Internal Server Error.  Check database connection')
    @Response('422', 'Validation Error')
    public async updateComment(
        @Request() req: express.Request, 
        @Path() type: string,
        @Path() id: string, 
        @Path() cid: string, 
        @Body() args: CommentUpdate
    ): Promise<any> {
      console.log(`updateComment(${id}, ${cid})`);
      const mgr = DocMgr.getInstance();
      const dt = mgr.getDocType(type);
      if (dt.validate?.updateComment) {
          dt.validate.updateComment(type, id, cid, args);
      }
      return mgr.updateComment(mgr.getCtx(req), { type, id }, cid, args);
    }
  
    @Delete("{id}/comment/{cid}")
    @Response('401', 'User access denied')
    @Response('404', 'Document does not exist')
    @Response('500', 'Internal Server Error.  Check database connection')
    @Response('422', 'Validation Error')
    public async deleteComment(
        @Request() req: express.Request, 
        @Path() type: string,
        @Path() id: string, 
        @Path() cid: string
    ): Promise<any> {
      console.log(`deleteComment(${id}, ${cid})`);
      const mgr = DocMgr.getInstance();
      const dt = mgr.getDocType(type);
      if (dt.validate?.deleteComment) {
          dt.validate.deleteComment(type, id, cid);
      }
      return mgr.deleteComment(mgr.getCtx(req), { type, id }, cid);
    }
  
}

@Route('/api/iterator}')
export class IteratorController extends Controller {
    @Get("{id}")
    public async getNextDoc(
        @Request() req: express.Request, 
        @Path() id: string, 
        @Query() count?: number,
    ): Promise<any> {
      console.log(`getNextDoc(${id}, ${count})`);
      const mgr = DocMgr.getInstance();
      const r = await mgr.getNextDoc(mgr.getCtx(req), id, count);
      return r;
    }

}
