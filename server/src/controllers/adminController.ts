import { Router, Request, Response, NextFunction } from "express";
import { DocMgr } from "../docMgr";
import { resolveUser } from "../middleware/auth";

export const adminRouter = Router();

// GET /api/admin/export
adminRouter.get("/export", resolveUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await DocMgr.getInstance().exportAll(req.userCtx!);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/export_ids
adminRouter.get("/export_ids", resolveUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await DocMgr.getInstance().exportIds(req.userCtx!);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/export/:collection/:id
adminRouter.get("/export/:collection/:id", resolveUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const doc = await DocMgr.getInstance().exportDoc(req.userCtx!, req.params.collection, req.params.id);
    res.json(doc);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/import
adminRouter.post("/import", resolveUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await DocMgr.getInstance().importAll(req.userCtx!, req.body);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/import/:collection/:id
adminRouter.post("/import/:collection/:id", resolveUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const doc = await DocMgr.getInstance().importDoc(
      req.userCtx!,
      req.params.collection,
      req.params.id,
      req.body
    );
    res.status(201).json(doc);
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/reset
adminRouter.get("/reset", resolveUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const simpleInit = req.query.simpleInit === "true";
    await DocMgr.getInstance().reset(req.userCtx!, simpleInit);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/health
adminRouter.get("/health", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = await DocMgr.getInstance().healthCheck();
    const httpStatus = status.pg ? 200 : 503;
    res.status(httpStatus).json(status);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/reindex – rebuild OpenSearch from PostgreSQL (disaster recovery)
adminRouter.post("/reindex", resolveUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const mgr = DocMgr.getInstance() as any;
    const allData = await mgr.db.exportAll();
    for (const [collection, docs] of Object.entries(allData)) {
      if (collection === "__user_groups") continue;
      await mgr.search.reindex(collection, docs as any[]);
    }
    res.json({ message: "Reindex complete", collections: Object.keys(allData) });
  } catch (err) {
    next(err);
  }
});
