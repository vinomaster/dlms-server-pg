import { Router, Request, Response, NextFunction } from "express";
import { DocMgr } from "../docMgr";
import { resolveUser } from "../middleware/auth";

export const userGroupRouter = Router();

// GET /api/user_groups
userGroupRouter.get("/", resolveUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await DocMgr.getInstance().listUserGroups();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/user_groups
userGroupRouter.post("/", resolveUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const group = await DocMgr.getInstance().createUserGroup(req.userCtx!, req.body);
    res.status(201).json(group);
  } catch (err) {
    next(err);
  }
});

// GET /api/user_groups/:id
userGroupRouter.get("/:id", resolveUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const group = await DocMgr.getInstance().getUserGroup(req.params.id);
    res.json(group);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/user_groups/:id
userGroupRouter.patch("/:id", resolveUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const group = await DocMgr.getInstance().updateUserGroup(req.userCtx!, req.params.id, req.body);
    res.json(group);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/user_groups/:id
userGroupRouter.delete("/:id", resolveUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const group = await DocMgr.getInstance().deleteUserGroup(req.userCtx!, req.params.id);
    res.json(group);
  } catch (err) {
    next(err);
  }
});
