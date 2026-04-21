/**
 * Copyright (c) 2024 Discover Financial Services
 */
import http from 'http';
import https from 'https';
/* eslint-disable @typescript-eslint/no-var-requires */
const proxying = require('proxying-agent');
/* eslint-enable @typescript-eslint/no-var-requires */
import { Logger } from './logger';

const log = new Logger('proxy');

export function monkeyPatch(module: any, functionName: any, newFunction: any) {
    module[functionName] = newFunction.bind(undefined, module[functionName]);
}

export function initProxy() {
    log.info('Initializing proxy');
    const httpProxy = process.env.http_proxy || process.env.HTTP_PROXY;
    const httpsProxy = process.env.https_proxy || process.env.HTTPS_PROXY;
    const noProxy =
        (process.env.no_proxy || process.env.NO_PROXY)?.split(',') || [];
    const useProxy =
        (process.env.use_proxy || process.env.USE_PROXY)?.split(',') || [];
    if (httpProxy) {
        log.info('Configuring http proxy');
        monkeyPatch(
            http,
            'request',
            function (originalRequest: any, options: any, callback: any) {
                if (!options.agent) {
                    let sendThruProxy = true;
                    const host = options.host || options.hostname;
                    if (host) {
                        for (let i = 0; i < noProxy.length; i++) {
                            if (host.endsWith(noProxy[i])) {
                                sendThruProxy = false;
                                break;
                            }
                        }
                        for (let i = 0; i < useProxy.length; i++) {
                            if (host == useProxy[i]) {
                                sendThruProxy = true;
                                break;
                            }
                        }
                    }
                    if (sendThruProxy) {
                        log.debug(
                            `Sending through HTTP proxy: request ${JSON.stringify(
                                options,
                                (key, value) => {
                                    if (key === 'nativeProtocols')
                                        return undefined;
                                    return value;
                                },
                                4
                            )}`
                        );
                        options.agent = proxying.create(httpProxy, 'http:');
                    }
                }
                return originalRequest(options, callback);
            }
        );
    }
    if (httpsProxy) {
        log.info('Configuring https proxy');
        monkeyPatch(
            https,
            'request',
            function (originalRequest: any, options: any, callback: any) {
                if (!options.agent) {
                    let sendThruProxy = true;
                    const host = options.host || options.hostname;
                    if (host) {
                        for (let i = 0; i < noProxy.length; i++) {
                            if (host.endsWith(noProxy[i])) {
                                sendThruProxy = false;
                                break;
                            }
                        }
                        for (let i = 0; i < useProxy.length; i++) {
                            if (host == useProxy[i]) {
                                sendThruProxy = true;
                                break;
                            }
                        }
                    }
                    if (sendThruProxy) {
                        log.debug(
                            `Sending through HTTPS proxy: request ${JSON.stringify(
                                options,
                                (key, value) => {
                                    if (key === 'nativeProtocols')
                                        return undefined;
                                    return value;
                                },
                                4
                            )}`
                        );
                        options.agent = proxying.create(httpsProxy, 'https:');
                    }
                }
                // In order to see the HTTP response associated with the outbound HTTP request, use the "debugCallback"
                // function as shown below.
                // return originalRequest(options, debugCallback);
                return originalRequest(options, callback);
            }
        );
    }
}

//function debugCallback(resp: any) {
//    const scode = resp.statusCode;
//    const hdrs = resp.rawHeaders;
//    let body = '';
//    resp.on('data', function (chunk: string) {
//        body += chunk;
//    });
//    resp.on('end', function () {
//        log.debug(`Received HTTPS response: scode=${scode}, body=${body}`);
//    });
//}
