/**
 * Copyright (c) 2024 Discover Financial Services
 */
import crypto = require('crypto');

export class Config {
    public readonly port: string;
    public readonly baseUrl: string;
    public readonly oauthClientId: string;
    public readonly oauthClientSecret: string;
    public readonly oauthIssuerUrl: string;
    public readonly oauthAuthorizationUrl: string;
    public readonly oauthTokenUrl: string;
    public readonly oauthUserInfoUrl: string;
    public readonly oauthCallbackUrl: string;
    public readonly sessionSecret: string;
    public readonly corsOrigin: string;
    public readonly oauthEnabled: boolean;
    public readonly basicAuthEnabled: boolean;
    public readonly debug: boolean;
    public readonly emailServer: string;

    constructor() {
        this.port = process.env.PORT || '3000';
        this.baseUrl = this.getStr('BASE_URL', 'http://localhost:' + this.port);
        this.debug = this.getBool('DEBUG', true);
        this.corsOrigin = this.getStr('CORS_ORIGIN', '*');
        this.oauthEnabled = this.getBool('OAUTH_ENABLED', false);
        this.basicAuthEnabled = this.getBool('BASIC_AUTH_ENABLED', false);
        if (this.oauthEnabled) {
            this.oauthClientId = this.getStr('OAUTH_CLIENT_ID');
            this.oauthClientSecret = this.getStr('OAUTH_CLIENT_SECRET');
            this.oauthIssuerUrl = this.getStr('OAUTH_ISSUER_URL');
            this.oauthAuthorizationUrl = this.getStr(
                'OAUTH_AUTHORIZATION_URL',
                `${this.oauthIssuerUrl}/v1/authorize`
            );
            this.oauthUserInfoUrl = this.getStr(
                'OAUTH_AUTHORIZATION_URL',
                `${this.oauthIssuerUrl}/v1/userinfo`
            );
            this.oauthTokenUrl = this.getStr(
                'OAUTH_TOKEN_URL',
                `${this.oauthIssuerUrl}/v1/token`
            );
            this.oauthCallbackUrl = `${this.baseUrl}/oauth/authorization`;
            this.sessionSecret = this.getStr(
                'SESSION_SECRET',
                crypto.randomBytes(48).toString('hex')
            );
        } else {
            this.oauthClientId = '';
            this.oauthClientSecret = '';
            this.oauthIssuerUrl = '';
            this.oauthAuthorizationUrl = '';
            this.oauthUserInfoUrl = '';
            this.oauthTokenUrl = '';
            this.oauthCallbackUrl = '';
            this.sessionSecret = this.getStr(
                'SESSION_SECRET',
                crypto.randomBytes(48).toString('hex')
            );
        }
        this.emailServer = this.getStr('EMAIL_SERVER', '');
    }

    getStr(name: string, def?: string): string {
        if (name in process.env) {
            return (process.env[name] as string).trim();
        }
        if (def !== undefined) {
            return def;
        }
        throw Error(`Environment variable '${name}' is not set`);
    }

    getBool(name: string, def: boolean): boolean {
        if (name in process.env) {
            return process.env[name]?.toLowerCase().trim() === 'true';
        }
        return def;
    }
}
