import { Request, Response, NextFunction } from "express";
import { DocError } from "dlms-base-pg";
import { logger } from "../logger";

export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (err instanceof DocError) {
    res.status(err.scode).json({ error: err.message });
    return;
  }
  if (err?.status) {
    res.status(err.status).json({ error: err.message ?? "Request error" });
    return;
  }
  logger.error("Unhandled error", { err, path: req.path });
  res.status(500).json({ error: "Internal server error" });
}
