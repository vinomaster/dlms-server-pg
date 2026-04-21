/**
 * Copyright (c) 2024 Discover Financial Services
 */
import express, { Request, Response, NextFunction } from 'express';
import { Logger } from './logger';
import { Config } from './config';
import { loginUser, sessionCookieName } from './auth';
import jwt from 'jsonwebtoken';
import passport from 'passport';
import session from 'express-session';
import { UserProfileService } from './userProfileService';
import { loginHtml } from './loginHtml';
import passportLocal = require('passport-local');
const LocalStrategy = passportLocal.Strategy;
const log = new Logger('authBasic');

// Function to add basic authentication middleware to the express application
export function addBasicAuthMiddleware(
    app: express.Application,
    cfg: Config,
    userProfileService: UserProfileService
) {
    log.debug(`Adding basic auth middleware`);

    // Middleware function for authentication
    function authenticationMiddleware() {
        return async function (
            req: Request,
            res: Response,
            next: NextFunction
        ) {
            log.debug('Checking for authentication...');
            // If the request path is /login, skip authentication
            if (req.path === '/login') {
                log.debug(' -- Login page, so skip authentication');
                return next();
            }
            // If the request is authenticated, proceed
            if (req.isAuthenticated()) {
                log.debug(' -- isAuthenticated = true');
                // Check for session user
                const sc = req.user as string; //req.cookies[sessionCookieName];
                if (sc) {
                    try {
                        // Verify the session cookie
                        const ctx: any = jwt.verify(sc, cfg.sessionSecret);
                        (req as any)._ctx = ctx;
                    } catch (e) {
                        log.err(' -- Error verifying session cookie: ', e);
                        // Redirect to login if session cookie verification fails
                        return res.redirect('/login');
                    }
                    //log.debug(`Session cookie was verified for ${JSON.stringify(ctx)}`);
                }
                return next();
            }
            // If the request has basic auth header, proceed
            if (hasBasicAuthHeader(req)) {
                try {
                    // Decode the basic auth credentials
                    const base64Credentials: any =
                        req.headers.authorization?.split(' ')[1];
                    const credentials = Buffer.from(
                        base64Credentials,
                        'base64'
                    ).toString('ascii');
                    const [uid, pwd] = credentials.split(':');

                    // Login the user
                    const ctx = await loginUser(uid, pwd, userProfileService);
                    (req as any)._ctx = ctx;
                    log.debug(`RequestContexted as`, ctx.user);

                    // Sign the jwt token
                    const token = jwt.sign(ctx, cfg.sessionSecret, {
                        expiresIn: '86400s',
                    });

                    // Set the session cookie
                    res.cookie(sessionCookieName, token, {
                        maxAge: 86400000,
                        httpOnly: false,
                    });
                    log.debug(
                        `Setting value of cookie ${sessionCookieName} to ${token}`
                    );
                    return next();
                } catch (e) {
                    log.debug('Basic auth credentials are bad:', e);
                }
            }
            // If not authenticated, redirect to login
            log.debug(' -- Not authenticated, so redirect to /login');
            res.redirect('/login');
        };
    }

    // Use session middleware
    app.use(
        session({
            secret: cfg.sessionSecret,
            resave: false,
            saveUninitialized: true,
        })
    );
    // Initialize passport
    app.use(passport.initialize());
    app.use(passport.session());

    // Serialize user
    passport.serializeUser((user: any, next: any) => {
        next(null, user);
    });

    // Deserialize user
    passport.deserializeUser((obj: any, next: any) => {
        next(null, obj);
    });

    // Use the LocalStrategy for passport authentication
    passport.use(
        new LocalStrategy(
            {
                usernameField: 'username',
                passwordField: 'password',
                passReqToCallback: true,
            },

            // Define the callback function for the LocalStrategy
            async (req: Request, uid: string, pwd: string, done: any) => {
                log.debug('Checking for user: ', uid);

                try {
                    // Attempt to login the user with the provided username and password
                    const ctx = await loginUser(uid, pwd, userProfileService);

                    // Attach the user context to the request
                    (req as any)._ctx = ctx;

                    // Log the user context
                    log.debug(`RequestContexted as `, ctx.user);

                    // Sign a JWT token with the user context
                    const token = jwt.sign(ctx, cfg.sessionSecret, {
                        expiresIn: '86400s',
                    });

                    // Log the new session cookie value
                    log.debug(
                        `Setting value of cookie ${sessionCookieName} to ${token}`
                    );

                    // Call the done function with the token and a success message
                    return done(null, token, {
                        message: 'Logged in successfully.',
                    });
                } catch (e) {
                    // If there's an error, call the done function with a failure message
                    return done(null, false, {
                        message: 'Incorrect username or password.',
                    });
                }
            }
        )
    );

    // POST /login route
    app.post('/login', (req, res, next) => {
        log.debug(`POST /login: `, req.body?.username);

        // Clear any existing loginMessage and session cookies
        res.clearCookie('loginMessage');
        res.clearCookie(sessionCookieName);

        // Authenticate the user using passport's local strategy
        passport.authenticate('local', (err: any, user: any, info: any) => {
            // Log the result of the authentication
            log.debug(
                `passport.authenticate: err=`,
                err,
                `user=`,
                user,
                `info=`,
                info
            );

            // If there's an error, pass it to the next middleware
            if (err) {
                return next(err);
            }

            // If there's no user (authentication failed), set a loginMessage cookie and redirect to /login
            if (!user) {
                log.debug('No user, so return error');
                res.cookie('loginMessage', info.message);
                return res.redirect('/login');
            }

            // If authentication succeeded, log the user in
            req.logIn(user, function (err) {
                log.debug(`req.logIn: err=`, err, `user=`, user);

                // Set a session cookie for the user
                res.cookie(sessionCookieName, user, {
                    maxAge: 86400000,
                    httpOnly: false,
                });

                // If there's an error, pass it to the next middleware
                if (err) {
                    return next(err);
                }

                // If login succeeded, redirect to the home page
                return res.redirect('/');
            });
        })(req, res, next); // Immediately invoke the returned function with the request, response, and next middleware
    });

    // GET /login route
    app.get('/login', (req: Request, res: Response) => {
        log.debug('Login');
        const content = loginHtml();
        res.setHeader('Content-Type', 'text/html');
        res.send(content);
    });

    // GET /logout route
    app.get('/logout', (req: Request, res: Response, next: NextFunction) => {
        log.debug('Logout');
        // Call the logout method provided by passport
        req.logout(function (err) {
            // Clear the loginMessage and session cookies
            res.clearCookie('loginMessage');
            res.clearCookie(sessionCookieName);

            // If there's an error during logout, pass it to the next middleware
            if (err) {
                return next(err);
            }

            // If logout succeeded, redirect to the home page
            res.redirect('/');
        });
    });

    // Use authentication middleware
    app.use(
        authenticationMiddleware(),
        (req: Request, resp: Response, next: NextFunction) => {
            log.debug('>>> Authenticated');
            return next();
        }
    );

    // GET /test route
    app.get('/test', function (req: Request, res: Response) {
        res.send('User is ' + JSON.stringify(req.user));
    });

    // Function to check if the request has basic auth header
    function hasBasicAuthHeader(req: Request): boolean {
        log.debug('hasBasicAuthHeader: headers=', req.headers);
        return (
            req.headers.authorization != undefined &&
            req.headers.authorization.indexOf('Basic ') >= 0
        );
    }
}
