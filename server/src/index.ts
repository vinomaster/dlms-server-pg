/**
 * index.ts – DLMS Polyglot Server entry point
 *
 * Boots the Express application, wires middleware & routes, then connects
 * to PostgreSQL and OpenSearch before accepting traffic.
 */

import express from "express";
import cors from "cors";
import compression from "compression";
import bodyParser from "body-parser";
import path from "path";

import { setupSession, setupBasicAuth, setupOAuth, corsOrigin } from "./middleware/auth";
import { errorHandler } from "./middleware/errorHandler";
import { docRouter } from "./controllers/docController";
import { attachmentRouter } from "./controllers/attachmentController";
import { adminRouter } from "./controllers/adminController";
import { userGroupRouter } from "./controllers/userGroupController";
import { actionRouter } from "./controllers/actionController";
import { DocMgr } from "./docMgr";
import { logger } from "./logger";

export function createApp(): express.Express {
  const app = express();

  // ── Global middleware ──────────────────────────────────────────────────────
  app.use(cors({ origin: corsOrigin(), credentials: true }));
  app.use(compression());
  app.use(bodyParser.json({ limit: "10mb" }));
  app.use(bodyParser.urlencoded({ extended: true }));

  // ── Auth ───────────────────────────────────────────────────────────────────
  setupSession(app);

  if (process.env.BASIC_AUTH_ENABLED === "true") {
    setupBasicAuth();
  }

  if (process.env.OAUTH_ENABLED === "true") {
    setupOAuth();

    // OAuth callback route
    const passport = require("passport");
    app.get(
      "/oauth/authorization",
      passport.authenticate("openidconnect", {
        successRedirect: "/",
        failureRedirect: "/login",
      })
    );
    app.get("/login", passport.authenticate("openidconnect"));
    app.get("/logout", (req: any, res: any) => {
      req.logout(() => res.redirect("/"));
    });
  }

  // ── API routes ─────────────────────────────────────────────────────────────
  app.use("/api/action", actionRouter);
  app.use("/api/admin", adminRouter);
  app.use("/api/docs", attachmentRouter);   // attachment routes before doc routes (more specific)
  app.use("/api/docs", docRouter);
  app.use("/api/user_groups", userGroupRouter);

  // ── Health check ───────────────────────────────────────────────────────────
  app.get("/health", (_req, res) => res.send("OK"));

  // ── Static React app (served by app server in prod) ───────────────────────
  const clientBuild = process.env.CLIENT_BUILD_PATH ?? path.join(__dirname, "../../client/build");
  app.use(express.static(clientBuild));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(clientBuild, "index.html"));
  });

  // ── Error handler (must be last) ───────────────────────────────────────────
  app.use(errorHandler);

  return app;
}

// ─── Startup ──────────────────────────────────────────────────────────────────

export async function start(): Promise<void> {
  const port = parseInt(process.env.PORT ?? "3000", 10);
  const app = createApp();

  // DocMgr must be initialized by the consuming application before calling
  // start().  This file only handles Express wiring.
  const mgr = DocMgr.getInstance();
  await mgr.init();

  const server = app.listen(port, () => {
    logger.info(`DLMS Polyglot Server listening on port ${port}`);
    logger.info(`Base URL: ${process.env.BASE_URL ?? `http://localhost:${port}`}`);
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`${signal} received – shutting down`);
    server.close(async () => {
      await mgr.shutdown();
      process.exit(0);
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
