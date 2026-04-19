import { Router, Request, Response, NextFunction } from "express";
import { DocMgr } from "../docMgr";
import { resolveUser } from "../middleware/auth";

export const actionRouter = Router();

// POST /api/action/:type/:id
actionRouter.post("/:type/:id", resolveUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await DocMgr.getInstance().invokeAction(
      req.userCtx!,
      req.params.type,
      req.params.id,
      req.body
    );
    res.json(result ?? {});
  } catch (err) {
    next(err);
  }
});
