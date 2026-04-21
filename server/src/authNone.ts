/**
 * Copyright (c) 2024 Discover Financial Services
 */
import express, { Request, Response, NextFunction } from 'express';
import { UserContext, User } from 'dlms-base';
import { Logger } from './logger';
import { Config } from './config';
import { sessionCookieName } from './auth';
import jwt from 'jsonwebtoken';
const log = new Logger('authNone');

// Function to add no authentication middleware to the express application
export function addNoAuthMiddleware(
    app: express.Application,
    user: User,
    cfg: Config
) {
    // Add a middleware to the express application
    app.use(async function setContext(
        req: Request,
        _resp: Response,
        next: NextFunction
    ) {
        // Create a user context with the provided user
        // NOTE: This is called and context is set every single request, overwriting any changes to context
        const ctx: UserContext = { user: user };

        // Attach the user context to the request
        (req as any)._ctx = ctx;

        // Log the default user being used
        log.debug(
            `No authenticated user - using default user ${JSON.stringify(ctx.user)}`
        );

        // Sign a JWT token with the user context
        const token = jwt.sign(ctx, cfg.sessionSecret, { expiresIn: '86400s' });

        // Set a session cookie with the token
        _resp.cookie(sessionCookieName, token, {
            maxAge: 86400000,
            httpOnly: false,
        });
        // log.debug(`Setting value of cookie ${sessionCookieName} to ${token}`);

        // Convert the user context to a string
        const value = JSON.stringify(ctx);

        // Set a header with the user context
        _resp.setHeader('no-auth-user', value);
        // log.debug(`Setting value of header no-auth-user to ${value}`);

        // Call the next middleware
        next();
    });
}
