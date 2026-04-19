/**
 * docController.ts
 *
 * Implements all /api/docs/:type and /api/docs/:type/:id endpoints.
 * Mirrors the original DLMS docController API surface exactly.
 *
 * Adds one new endpoint: GET /api/docs/:type/search?q=<query>
 * which routes through OpenSearch for full-text search.
 */

import { Router, Request, Response, NextFunction } from "express";
import { DocMgr } from "../docMgr";
import { resolveUser } from "../middleware/auth";

export const docRouter = Router();

// GET /api/docs/:type/search  – OpenSearch full-text search
docRouter.get("/:type/search", resolveUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const mgr = DocMgr.getInstance();
    const ctx = req.userCtx!;
    const query = (req.query.q as string) ?? "";
    const filters = req.query.filters ? JSON.parse(req.query.filters as string) : undefined;
    const result = await mgr.searchDocs(ctx, req.params.type, query, filters);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/docs/:type – list documents (with optional match/projection)
docRouter.get("/:type", resolveUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const mgr = DocMgr.getInstance();
    const ctx = req.userCtx!;
    const match = req.query.match ? JSON.parse(req.query.match as string) : undefined;
    const projection = req.query.projection
      ? JSON.parse(req.query.projection as string)
      : undefined;
    const result = await mgr.listDocs(ctx, req.params.type, match, projection);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/docs/:type – create document (auto-generated id)
docRouter.post("/:type", resolveUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const mgr = DocMgr.getInstance();
    const doc = await mgr.createDoc(req.userCtx!, req.params.type, req.body);
    res.status(201).json(doc);
  } catch (err) {
    next(err);
  }
});

// GET /api/docs/:type/:id – retrieve single document
docRouter.get("/:type/:id", resolveUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const mgr = DocMgr.getInstance();
    const doc = await mgr.getDoc(req.userCtx!, req.params.type, req.params.id);
    res.json(doc);
  } catch (err) {
    next(err);
  }
});

// POST /api/docs/:type/:id – create document with specific id
docRouter.post("/:type/:id", resolveUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const mgr = DocMgr.getInstance();
    const doc = await mgr.createDoc(req.userCtx!, req.params.type, req.body, req.params.id);
    res.status(201).json(doc);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/docs/:type/:id – update document
docRouter.patch("/:type/:id", resolveUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const mgr = DocMgr.getInstance();
    const doc = await mgr.updateDoc(req.userCtx!, req.params.type, req.params.id, req.body);
    res.json(doc);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/docs/:type/:id – delete document
docRouter.delete("/:type/:id", resolveUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const mgr = DocMgr.getInstance();
    const doc = await mgr.deleteDoc(req.userCtx!, req.params.type, req.params.id);
    res.json(doc);
  } catch (err) {
    next(err);
  }
});
