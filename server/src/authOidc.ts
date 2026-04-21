/**
 * Copyright (c) 2024 Discover Financial Services
 */
import express, { Request, Response, NextFunction } from 'express';
import { UserContext } from 'dlms-base';
import { Logger } from './logger';
import { Config } from './config';
import { loginUser, sessionCookieName } from './auth';
import jwt from 'jsonwebtoken';
import passport from 'passport';
import session from 'express-session';
import { UserProfileService } from './userProfileService';
import { throwErr } from './err';
import Strategy = require('passport-openidconnect');
import { DocMgr } from './docMgr';
const log = new Logger('authOidc');

/**
 * Add authentication middleware
 *
 * @summary
 * See https://developer.okta.com/blog/2018/05/18/node-authentication-with-passport-and-oidc
 *
 * @param app - Express application
 * @param cfg - configuration
 * @param userProfileService - user profile service
 */
export function addOidcAuthMiddleware(
    app: express.Application,
    cfg: Config,
    userProfileService: UserProfileService
) {
    app.use(async function (req: Request, resp: Response, next: NextFunction) {
        return await authenticate(req, resp, next, cfg, userProfileService);
    });
    app.use(
        session({
            secret: cfg.sessionSecret,
            resave: false,
            saveUninitialized: true,
        })
    );
    if (cfg.oauthEnabled) {
        // app.use(passport.initialize());
        app.use(passport.session());
        passport.use(
            'oidc',
            new Strategy(
                {
                    issuer: cfg.oauthIssuerUrl,
                    authorizationURL: cfg.oauthAuthorizationUrl,
                    tokenURL: cfg.oauthTokenUrl,
                    userInfoURL: cfg.oauthUserInfoUrl,
                    clientID: cfg.oauthClientId,
                    clientSecret: cfg.oauthClientSecret,
                    callbackURL: cfg.oauthCallbackUrl,
                    scope: 'openid profile',
                    passReqToCallback: true,
                },
                async (
                    req: Request,
                    issuer: any,
                    profile: any,
                    context: any,
                    idToken: any,
                    accessToken: any,
                    refreshToken: any,
                    done: any
                ) => {
                    log.debug(
                        'OIDC response:  \nprofile=',
                        profile,
                        '\nidToken=',
                        idToken,
                        '\naccessToken=',
                        accessToken,
                        '\nrefreshToken=',
                        refreshToken,
                        '\ncontext=',
                        context
                    );
                    const claims1 = JSON.parse(
                        Buffer.from(idToken.split('.')[1], 'base64').toString()
                    );
                    log.debug(
                        `OIDC claims from idToken: ${JSON.stringify(claims1)}`
                    );
                    const claims = JSON.parse(
                        Buffer.from(
                            accessToken.split('.')[1],
                            'base64'
                        ).toString()
                    );
                    log.debug(
                        `OIDC claims from accessToken: ${JSON.stringify(claims)}`
                    );
                    let ctx;
                    try {
                        // ctx = await getUserContextFromClaims(claims.email, userProfileService);
                        const ctxs = await userProfileService.get(claims.email);
                        ctx = ctxs[0];
                    } catch (ex) {
                        log.err('Error: ', ex);
                        return done(ex, null);
                    }
                    ctx['oauth'] = { accessToken };
                    (req as any)._ctx = ctx;
                    return done(null, profile);
                }
            )
        );
        
    }
    passport.serializeUser((user: any, next: any) => {
        next(null, user);
    });
    passport.deserializeUser((obj: any, next: any) => {
        next(null, obj);
    });
    app.use('/login', passport.authenticate('oidc'));
    app.get('/logout', (req: Request, res: Response) => {
        log.debug('Logging out');
        //req.logout();
        log.debug('Destroying session');
        req.session.destroy((err: any) => {
            if (err) {
                log.warn(`Failed to destroy session: ${err.stack}`);
            }
            res.clearCookie(sessionCookieName);
            res.clearCookie("accessToken");
            res.redirect('/');
        });
        if (cfg.oauthEnabled) {
            // @TODO: If logout endpoint, then call it
        }
    });
    if (process.env.PASSPORT_DEBUG) {
        log.debug(`PASSPORT_DEBUG is set`);
        app.use(
            '/oauth/authorization',
            function debugPassportAuthentication(req: Request, resp: Response) {
                passport.authenticate(
                    'oidc',
                    function (error: any, user: any, info: any) {
                        log.debug(`Passport error: `, error);
                        log.debug('Passport user: ', user);
                        log.debug('Passport info: ', info);
                        if (error) {
                            resp.status(401).send(error);
                        } else if (!user) {
                            resp.status(401).send(info);
                        } else {
                            const ctx: UserContext = (req as any)._ctx;
                            log.debug(`OAuth authenticated user is`, ctx.user);
                            const token = jwt.sign(ctx, cfg.sessionSecret, {
                                expiresIn: '86400s',
                            });
                            resp.cookie(sessionCookieName, token, {
                                maxAge: 86400000,
                                httpOnly: false,
                            });
                            resp.cookie("accessToken", ctx.oauth?.accessToken, {
                                maxAge: 86400000,
                                httpOnly: false,
                            })
                            log.debug(
                                `Setting value of cookie ${sessionCookieName} to ${token}`
                            );
                            log.debug(
                                `Setting value of cookie accessToken to ${ctx.oauth?.accessToken}`
                            );
            
                            const c = req.cookies['originalUrl'];
                            const h = req.cookies['currentHash'];
                            log.debug(`Getting cookie originalUrl = ${c}`);
                            log.debug(`Getting cookie currentHash = ${h}`);
                            if (c) {
                                resp.clearCookie('originalUrl');
                                resp.redirect(c + (h ? h : ''));
                            } else {
                                resp.redirect('/');
                            }
                        }
                    }
                )(req, resp);
            }
        );
    } else {
        log.debug(`PASSPORT_DEBUG is not set`);
        app.use(
            '/oauth/authorization',
            passport.authenticate('oidc', { failureRedirect: '/error' }),
            (req: Request, resp: Response) => {
                // console.log("Oauth successful: request=",req);
                const ctx: UserContext = (req as any)._ctx;
                log.debug(`OAuth authenticated user is`, ctx.user);
                const token = jwt.sign(ctx, cfg.sessionSecret, {
                    expiresIn: '86400s',
                });
                resp.cookie(sessionCookieName, token, {
                    maxAge: 86400000,
                    httpOnly: false,
                });
                resp.cookie("accessToken", ctx.oauth?.accessToken, {
                    maxAge: 86400000,
                    httpOnly: false,
                })
                log.debug(
                    `Setting value of cookie ${sessionCookieName} to ${token}`
                );
                log.debug(
                    `Setting value of cookie accessToken to ${ctx.oauth?.accessToken}`
                );

                const c = req.cookies['originalUrl'];
                const h = req.cookies['currentHash'];
                log.debug(`Getting cookie originalUrl = ${c}`);
                log.debug(`Getting cookie currentHash = ${h}`);
                log.debug(`Getting cookie originalUrl = ${c}`);
                if (c) {
                    resp.clearCookie('originalUrl');
                    resp.redirect(c + (h ? h : ''));
                } else {
                    resp.redirect('/');
                }
            }
        );
    }
}

/**
 * Authenticate the user with Oauth
 *
 * @param req - Request object
 * @param resp - Response object
 * @param next - Function to call next
 * @param cfg - Configuration
 * @param userProfileService
 * @returns Response
 */
async function authenticate(
    req: Request,
    resp: Response,
    next: NextFunction,
    cfg: Config,
    userProfileService: UserProfileService
) {
    log.debug(`authenticate()`);
    if (req.method == 'OPTIONS') {
        return resp.sendStatus(200);
    }
    if (
        req.path === '/login' ||
        req.path === '/logout' ||
        req.path === '/oauth/authorization'
    ) {
        log.debug(`Skipping authentication for ${req.method} ${req.path}`);
        return next();
    }
    //log.debug(`Beginning authentication for ${req.method} ${req.path}`);
    //console.log("Headers=",req.headers);
    // Check basic auth for /basic
    if (req.path === '/basic') {
        return await basicAuth(req, resp, next, cfg, userProfileService);
    }
    // Check for session cookie
    const sc = req.cookies[sessionCookieName];
    if (sc) {
        try {
            const ctx: any = await jwt.verify(sc, cfg.sessionSecret);
            // log.debug(`Session cookie was verified for ${JSON.stringify(ctx)}`);

            // If cookie doesn't have user.roles, then get them & update session cookie
            // (This happens when a remote app calls API with an Oauth access token, which doesn't go through passport.authenticate)
            if (!ctx.user.roles.length) {
                const dm = DocMgr.getInstance();
                const roles = await dm.getRoles(ctx);
                ctx.user.roles = roles;
                log.debug(`Session cookie was missing roles, so add ${JSON.stringify(ctx)}`);

                const token = jwt.sign(ctx, cfg.sessionSecret, {
                    // expiresIn: '86400s',
                });
                resp.cookie(sessionCookieName, token, {
                    maxAge: 86400000,
                    httpOnly: false,
                });
                log.debug(`Setting value of cookie ${sessionCookieName} to ${token}`);
            }
            (req as any)._ctx = ctx;
            return next();
        } catch (e) {
            log.err('Error verifying session cookie: ', e);
            resp.clearCookie(sessionCookieName);
            return resp.redirect('/login');
        }
    }
    if (hasBasicAuthHeader(req)) {
        return await basicAuth(req, resp, next, cfg, userProfileService);
    }
    if (hasBearerAuthHeader(req)) {
        console.log("HAS BEARER HEADER = TRUE");
        try {
            // Get Oauth authorization token
            const accessToken: any = req.headers.authorization?.split(' ')[1];
            console.log("authToken =", accessToken);

            const introspectUrl = cfg.oauthIssuerUrl + "/v1/introspect";
            const formData = {
                token: accessToken,
                token_type_hint: 'access_token'
            }
            const r = await fetch(introspectUrl,
                {
                    method: "POST",
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        Authorization: 'Basic ' + btoa(cfg.oauthClientId + ":" + cfg.oauthClientSecret),
                    },
                    body: new URLSearchParams(formData).toString()
                }
            )
            const claims = await r.json();
            // console.log("BEARER DATA=", claims);
       
            let ctx;
            try {
                if (!claims.active) {
                    return resp.status(401).send('bearer token expired - reauthenticate').end();
                }
                const ctxs = await userProfileService.get(claims.email);
                ctx = ctxs[0];
            } catch (ex) {
                log.err('Error: ', ex);
                return resp.status(401).send('bearer token expired - reauthenticate').end();
            }
            ctx['oauth'] = { accessToken };
            (req as any)._ctx = ctx;


            log.debug(`OAuth authenticated user is`, ctx.user);
            const token = jwt.sign(ctx, cfg.sessionSecret, {
                expiresIn: '86400s',
            });
            resp.cookie(sessionCookieName, token, {
                maxAge: 86400000,
                httpOnly: false,
            });
            resp.cookie("accessToken", ctx.oauth.accessToken, {
                maxAge: 86400000,
                httpOnly: false,
            })
            log.debug(
                `Setting value of cookie ${sessionCookieName} to ${token}`
            );
            log.debug(
                `Setting value of cookie accessToken to ${ctx.oauth.accessToken}`
            );

            return next();
        } catch (e) {
            
        }
    }
    log.debug(
        `Session cookie not found for ${req.path}; redirecting to /login`
    );
    // console.log("Before oauth redirect: request =",req);
    log.debug(`Setting cookie originalUrl = ${req.path}`);
    resp.cookie('originalUrl', req.path);
    return resp.redirect('/login');
}

/**
 * Authenticate the user without Oauth
 *
 * @param req - Request object
 * @param resp - Response object
 * @param next - Function to call next
 * @param cfg - Configuration
 * @param userProfileService
 * @returns Response
 */
async function basicAuth(
    req: Request,
    resp: Response,
    next: NextFunction,
    cfg: Config,
    userProfileService: UserProfileService
) {
    if (hasBasicAuthHeader(req)) {
        log.debug('Using basic authentication');
        try {
            // verify auth credentials
            const base64Credentials: any =
                req.headers.authorization?.split(' ')[1];
            const credentials = Buffer.from(
                base64Credentials,
                'base64'
            ).toString('ascii');
            const [uid, pwd] = credentials.split(':');
            const ctx = await loginUser(uid, pwd, userProfileService);
            (req as any)._ctx = ctx;
            log.debug(`RequestContexted as `, ctx.user);
            const token = jwt.sign(ctx, cfg.sessionSecret, {
                expiresIn: '86400s',
            });
            resp.cookie(sessionCookieName, token, {
                maxAge: 86400000,
                httpOnly: false,
            });
            log.debug(
                `Setting value of cookie ${sessionCookieName} to ${token}`
            );
            if (req.path === '/basic') {
                return resp.redirect('/');
            } else {
                return next();
            }
        } catch (e) {
            log.debug('Sending 401 response with WWW-Authenticate header');
            resp.setHeader('WWW-Authenticate', 'Basic');
            resp.sendStatus(401);
        }
    } else if (req.path === '/basic') {
        log.debug('Sending 401 response with WWW-Authenticate header');
        resp.setHeader('WWW-Authenticate', 'Basic');
        resp.sendStatus(401);
    } else {
        throwErr(500, `Should not reach here`);
    }
}

function hasBasicAuthHeader(req: Request): boolean {
    log.debug('hasBasicAuthHeader: headers=', req.headers);
    return (
        req.headers.authorization != undefined &&
        req.headers.authorization.indexOf('Basic ') >= 0
    );
}

function hasBearerAuthHeader(req: Request): boolean {
    log.debug('hasBearerAuthHeader: headers=', req.headers);
    return (
        req.headers.authorization != undefined &&
        req.headers.authorization.indexOf('Bearer ') >= 0
    );
}
