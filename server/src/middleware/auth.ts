/**
 * auth.ts
 *
 * Authentication middleware for DLMS Polyglot server.
 * Supports:
 *   • HTTP Basic Auth  (BASIC_AUTH_ENABLED=true)
 *   • OAuth 2.0 / OIDC (OAUTH_ENABLED=true)
 *   • API Token        (API_TOKEN env var)
 *   • No-auth dev mode (all other cases)
 */

import { Request, Response, NextFunction } from "express";
import passport from "passport";
import { Strategy as BasicStrategy } from "passport-http";
import { Strategy as OpenIDConnectStrategy } from "passport-openidconnect";
import session from "express-session";
import { DocMgr } from "../docMgr";
import { UserContext } from "dlms-base-pg";
import { logger } from "../logger";

declare global {
  namespace Express {
    interface Request {
      userCtx?: UserContext;
    }
  }
}

// ─── Session setup ────────────────────────────────────────────────────────────

export function setupSession(app: import("express").Express): void {
  app.use(
    session({
      secret: process.env.SESSION_SECRET ?? require("crypto").randomBytes(48).toString("hex"),
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: process.env.NODE_ENV === "production",
        httpOnly: true,
        maxAge: 8 * 60 * 60 * 1000, // 8 hours
      },
    })
  );
  app.use(passport.initialize());
  app.use(passport.session());

  passport.serializeUser((user: any, done) => done(null, user));
  passport.deserializeUser((user: any, done) => done(null, user));
}

// ─── Basic Auth strategy ──────────────────────────────────────────────────────

export function setupBasicAuth(): void {
  passport.use(
    new BasicStrategy(async (uid, pwd, done) => {
      try {
        const mgr = DocMgr.getInstance();
        const ctxArr = await mgr.verifyUser(uid, pwd);
        if (!ctxArr) return done(null, false);
        return done(null, ctxArr);
      } catch (err) {
        return done(err);
      }
    })
  );
}

// ─── OIDC strategy ────────────────────────────────────────────────────────────

export function setupOAuth(): void {
  const issuer = process.env.OAUTH_ISSUER_URL ?? "";
  passport.use(
    new OpenIDConnectStrategy(
      {
        issuer,
        authorizationURL:
          process.env.OAUTH_AUTHORIZATION_URL ?? `${issuer}/v1/authorize`,
        tokenURL:
          process.env.OAUTH_TOKEN_URL ?? `${issuer}/v1/token`,
        userInfoURL: `${issuer}/v1/userinfo`,
        clientID: process.env.OAUTH_CLIENT_ID ?? "",
        clientSecret: process.env.OAUTH_CLIENT_SECRET ?? "",
        callbackURL: `${process.env.BASE_URL ?? "http://localhost:3000"}/oauth/authorization`,
        scope: "openid profile email",
      },
      async (issuer: string, profile: any, done: Function) => {
        try {
          const mgr = DocMgr.getInstance();
          const ctxArr = await mgr.getUserProfile(profile);
          if (!ctxArr || ctxArr.length === 0) return done(null, false);
          return done(null, ctxArr[0]);
        } catch (err) {
          return done(err);
        }
      }
    )
  );
}

// ─── Request-level middleware ─────────────────────────────────────────────────

/**
 * Resolves a UserContext for every request and attaches it to `req.userCtx`.
 * Priority:  API Token → Session (OAuth) → Basic Auth → Dev stub
 */
export async function resolveUser(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // 1. API Token
    const token = req.headers["x-api-token"] ?? req.query["api_token"];
    if (token && token === process.env.API_TOKEN) {
      req.userCtx = buildAdminCtx();
      return next();
    }

    // 2. Session (OIDC)
    if (req.isAuthenticated && req.isAuthenticated() && (req as any).user) {
      req.userCtx = (req as any).user as UserContext;
      return next();
    }

    // 3. Basic Auth header
    if (process.env.BASIC_AUTH_ENABLED === "true") {
      const authHeader = req.headers.authorization ?? "";
      if (authHeader.startsWith("Basic ")) {
        passport.authenticate("basic", { session: false }, (err: any, user: any) => {
          if (err) return next(err);
          if (user) req.userCtx = user;
          return next();
        })(req, res, next);
        return;
      }
    }

    // 4. IDS_ADMIN env – allow named admin IDs
    const adminIds = (process.env.IDS_ADMIN ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const uid = (req as any).user?.id;
    if (uid && adminIds.includes(uid)) {
      req.userCtx = buildAdminCtx(uid);
      return next();
    }

    // 5. Dev/no-auth fallback
    if (process.env.NODE_ENV !== "production") {
      req.userCtx = buildGuestCtx();
      return next();
    }

    res.status(401).json({ error: "Unauthorized" });
  } catch (err) {
    next(err);
  }
}

// ─── CORS & env helpers ───────────────────────────────────────────────────────

export function corsOrigin(): string {
  return process.env.CORS_ORIGIN ?? "*";
}

// ─── Stubs for dev ────────────────────────────────────────────────────────────

function buildAdminCtx(id = "admin"): UserContext {
  return {
    isAdmin: true,
    user: {
      id,
      email: `${id}@dlms.local`,
      name: "Admin",
      department: "",
      title: "Administrator",
      employeeNumber: "0",
      roles: ["Admin"],
    },
  };
}

function buildGuestCtx(): UserContext {
  return {
    isAdmin: false,
    user: {
      id: "dev-guest",
      email: "dev@dlms.local",
      name: "Dev Guest",
      department: "Engineering",
      title: "Developer",
      employeeNumber: "0",
      roles: ["Employee"],
    },
  };
}
