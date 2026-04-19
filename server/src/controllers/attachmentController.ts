import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import { DocMgr } from "../docMgr";
import { resolveUser } from "../middleware/auth";

export const attachmentRouter = Router();

// multer – store in memory, max 50 MB per file
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// GET /api/docs/attachments – all attachments (admin)
attachmentRouter.get("/attachments", resolveUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await DocMgr.getInstance().listAllAttachments();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/docs/:collection/:docId/attachments – list attachments for doc
attachmentRouter.get("/:collection/:docId/attachments", resolveUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await DocMgr.getInstance().listAttachments(
      req.userCtx!,
      req.params.collection,
      req.params.docId
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/docs/:collection/:docId/attachments – upload attachment
attachmentRouter.post(
  "/:collection/:docId/attachments",
  resolveUser,
  upload.single("file"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: "No file uploaded" });
        return;
      }
      const result = await DocMgr.getInstance().createAttachment(
        req.userCtx!,
        req.params.collection,
        req.params.docId,
        req.file
      );
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/docs/:collection/:docId/attachments/:id – download attachment
attachmentRouter.get("/:collection/:docId/attachments/:id", resolveUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const stream = await DocMgr.getInstance().getAttachment(
      req.userCtx!,
      req.params.collection,
      req.params.docId,
      req.params.id
    );
    res.setHeader("Content-Disposition", `attachment`);
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/docs/:collection/:docId/attachments/:id – delete attachment
attachmentRouter.delete("/:collection/:docId/attachments/:id", resolveUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await DocMgr.getInstance().deleteAttachment(
      req.userCtx!,
      req.params.collection,
      req.params.docId,
      req.params.id
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});
