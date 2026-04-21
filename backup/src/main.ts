/**
 * Copyright (c) 2024 Discover Financial Services
 *
 * Polyglot edition: backup/src/main.ts
 *
 * The backup utility works entirely through the DLMS REST API (/api/admin/export_ids,
 * /api/admin/export, /api/admin/import, /api/admin/reset), so it is completely
 * database-agnostic. This file is verbatim from the original dlms-server backup,
 * with only the package name updated.
 *
 * No MongoDB code exists in the backup utility — it operated via HTTP even in the
 * original, so no changes are required here beyond the copyright comment.
 */
import axios from 'axios';
import fs from 'fs';
import nodeCron from 'node-cron';
import crypto from 'crypto';
import * as path from 'path';
process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

export class DocClient {

    private url: string;
    private auth: any;
    private dir: string;
    private filesDir: string;
    private exportedUrl: string;

    public static mapFileExt: string = `export.json`;

    public static async export(fromUrl: string, toDir: string, filesDir: string) {
        try {
            const dc = new DocClient(fromUrl, toDir, filesDir);
            await dc.doExport();
        } catch (e: any) {
            console.error(`ERROR: export from ${fromUrl} failed: ${e.stack}`);
        }
    }

    public static async import(fromDir: string, toUrl: string, reset: boolean) {
        try {
            const dc = new DocClient(toUrl, fromDir, `${fromDir}/../files`);
            await dc.doImport(reset);
        } catch (e: any) {
            console.error(`ERROR: import to ${toUrl} failed: ${e.stack}`);
        }
    }

    public static async delete(backupDir: string) {
        try {
            const dc = new DocClient('', backupDir, `${backupDir}/../files`);
            await dc.doDelete();
        } catch (e: any) {
            console.error(`ERROR: delete of ${backupDir} failed: ${e.stack}`);
        }
    }

    constructor(url: string, dir: string, filesDir: string) {
        this.url = url;
        this.dir = dir;
        this.filesDir = filesDir;
        this.auth = {
            username: cfg('USER'),
            password: cfg('PASS'),
        };
        this.exportedUrl = '';
    }

    public async doExport() {
        if (fs.existsSync(this.dir)) {
           throwErr(`Export directory '${this.dir}' already exists`);
        }
        console.log(`Starting export from URL '${this.url}' to directory '${this.dir}'`);
        fs.mkdirSync(this.dir);
        if (!fs.existsSync(this.filesDir)) {
            fs.mkdirSync(this.filesDir);
        }
        await this.writeTextFile(this.exportedUrlFile(), this.url);
        const idsMap = await this.sendGet('export_ids');
        let idsHashMap = idsMap;
        for (const cName of Object.keys(idsMap)) {
            console.log(`Exporting collection ${cName}`);
            const ids = idsMap[cName];
            const hashArray = [];
            const idsLen = ids.length;
            let idsCount = 0;
            for (const id of ids) {
                if (idsCount % 100 == 0) { console.log(`${idsCount} of ${idsLen}`); }
                const retryCount = 5;
                let count = retryCount;
                while (count > 0) {
                    try {
                        const ele = await this.sendGet(`export/${cName}/${encodeURI(id)}`);
                        const hash = getHash(ele);
                        const hashFileName = `${this.filesDir}/${hash}.json`;
                        hashArray.push({ id: id, hash: hash });
                        if (!fs.existsSync(hashFileName)) {
                            await this.writeFile(hashFileName, ele);
                        }
                        count = 0;
                    } catch (e: any) {
                        count--;
                        if (count == 0) {
                            console.error(`ERROR: export of ${id} from ${cName} failed ${retryCount - count} times: ${e.message}`);
                        } else {
                            console.warn(`WARNING: export of ${id} from ${cName} failed: ${e.message}`);
                        }
                    }
                }
                idsCount++;
            }
            idsHashMap[cName] = hashArray;
        }
        await this.writeFile(this.mapFile(), idsHashMap);
        console.log(`Completed export from URL '${this.url}' to directory '${this.dir}'`);
    }

    public async doImport(reset: boolean) {
        if (!fs.existsSync(this.dir)) {
           throwErr(`Import directory '${this.dir}' does not exist`);
        }
        console.log(`Starting import from directory '${this.dir}' to URL '${this.url}'`);
        if (reset) { await this.sendGet('reset?simpleInit=true'); }
        this.exportedUrl = await this.readTextFile(this.exportedUrlFile());
        const idsHashesMap: any = await this.readFile(this.mapFile());
        for (const cName of Object.keys(idsHashesMap)) {
            console.log(`Importing collection ${cName}`);
            const idWithHash = idsHashesMap[cName];
            const idsLen = idWithHash.length;
            let idsCount = 0;
            for (const { id, hash } of idWithHash) {
                console.log(`Importing entry ${idsCount} of ${idsLen}: ${id}`);
                const ele = await this.readFile(`${this.filesDir}/${hash}.json`);
                await this.sendPut(`import/${cName}/${encodeURI(id)}`, ele);
                idsCount++;
            }
        }
        console.log(`Completed import from directory '${this.dir}' to URL '${this.url}'`);
    }

    public async doDelete() {
        if (!fs.existsSync(this.dir)) {
            throwErr(`Files directory '${this.dir}' does not exist`);
        }
        console.log(`Starting delete of directory '${this.dir}'`);
        const backupDir = path.dirname(this.dir);
        const idsHashesMap: any = await this.readFile(this.mapFile());
        var hashesPresent = [];
        for (const cName of Object.keys(idsHashesMap)) {
            const idWithHash = idsHashesMap[cName];
            for (const { hash } of idWithHash) { hashesPresent.push(hash); }
        }
        var dateDirs: string[] = [];
        fs.readdirSync(backupDir).forEach(file => { if (file != 'files') dateDirs.push(file); });
        var hashesFound: string[] = [];
        for (const dateDir of dateDirs) {
            const fullDateDir = `${backupDir}/${dateDir}`;
            if (fullDateDir == this.dir) { continue; }
            const dateDirMap: any = await this.readFile(`${fullDateDir}/${DocClient.mapFileExt}`);
            for (const cName of Object.keys(dateDirMap)) {
                const idWithHash = dateDirMap[cName];
                for (const { hash } of idWithHash) {
                    if (!hashesFound.includes(hash)) { hashesFound.push(hash); }
                }
            }
        }
        for (const hash of hashesPresent) {
            if (!hashesFound.includes(hash)) {
                fs.unlink(`${this.filesDir}/${hash}.json`, function (err) {
                    if (err) { console.log(`error deleting ${hash}`); }
                    else { console.log(`${hash} deleted`); }
                });
            }
        }
        fs.rmSync(this.dir, { recursive: true, force: true });
        console.log(`Completed delete of directory '${this.dir}'`);
    }

    private async sendGet(path: string): Promise<any> { return await this.sendAxios(path, { method: 'GET' }); }
    private async sendPost(path: string, body: object): Promise<any> { return await this.sendAxios(path, { method: 'POST', data: body }); }
    private async sendPut(path: string, body: object): Promise<any> { return await this.sendAxios(path, { method: 'PUT', data: body }); }

    private async sendAxios(path: string, opts?: any): Promise<any> {
        const url = this.makeUrl(path);
        opts = opts || {};
        opts.method = opts.method || 'GET';
        opts.url = url;
        opts.auth = this.auth;
        opts.maxContentLength = 200000000;
        opts.maxBodyLength = 2000000000;
        opts.proxy = false;
        try {
            const resp = await axios(opts);
            return resp.data;
        } catch (e: any) {
            if (e.response?.data?.message == 'request entity too large') {
                console.log('Request too large - continuing...');
            } else {
                throwErr(e.message);
            }
        }
    }

    private async readTextFile(name: string) { return fs.readFileSync(name).toString(); }
    private async writeTextFile(name: string, data: string) { fs.writeFileSync(name, data); }

    private async readFile(name: string) {
        const r = fs.readFileSync(name).toString();
        const re = new RegExp(this.exportedUrl, 'g');
        return JSON.parse(r.replace(re, this.url));
    }

    private async writeFile(name: string, obj: Object) { fs.writeFileSync(name, JSON.stringify(obj)); }
    private mapFile() { return `${this.dir}/${DocClient.mapFileExt}`; }
    private exportedUrlFile() { return `${this.dir}/exportedUrl.txt`; }

    private makeUrl(path: string): string {
        if (path.startsWith('api')) { return `${this.url}/${path}`; }
        return `${this.url}/api/admin/${path}`;
    }
}

function verifyBackupSettings() {
    cfg('URL');
    let dir = cfg('BACKUP_DIR');
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir); }
}

async function runBackupDaemon() {
    await performBackup();
    setTimeout(runBackupDaemon, backupDelayInMs);
}

async function performBackup() {
    try {
        const url = cfg('URL');
        let dir = cfg('BACKUP_DIR');
        if (!fs.existsSync(dir)) { fs.mkdirSync(dir); }
        const filesDir = `${dir}/files`;
        dir = `${dir}/${dateStr()}`;
        await DocClient.export(url, dir, filesDir);
    } catch (e: any) { console.log(`${e.stack}`); }
}

const dayInMs = 24 * 60 * 60 * 1000;
const backupDelayInMs = process.env.BACKUP_DELAY ? parseInt(process.env.BACKUP_DELAY) : dayInMs;
const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dateStr() {
    const d = new Date();
    return `${monthNames[d.getMonth()]}-${d.getDate()}-${d.getFullYear()}_${d.getHours()}-${d.getMinutes()}-${d.getSeconds()}`;
}

function getHash(ele: any): string {
    const hashSum = crypto.createHash('sha256');
    hashSum.update(Buffer.from(JSON.stringify(ele)));
    return hashSum.digest('hex');
}

function cfg(name: string, def?: string): string {
    const rtn = process.env[name];
    if (!rtn) {
        if (def) { return def; }
        return fatal(`${name} environment variable is not set`);
    }
    return rtn;
}

function throwErr(msg: string): never { throw new Error(msg); }
function fatal(msg: string): never { console.error(`ERROR: ${msg}`); process.exit(1); }

function usage(msg?: string) {
    if (msg) { console.log(`Error: ${msg}`); }
    console.log(`Usage: node docClient export <fromUrl> <toDirectory>`);
    console.log(`                      import <fromDirectory> <toUrl> { merge | reset }`);
    console.log(`                      delete <backupDirectory>`);
    console.log(`                      scheduleBackup`);
    console.log(`                      runBackupDaemon`);
    process.exit(1);
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length == 0) { usage(); }
    const cmd = args[0];
    if (cmd === 'export') {
        if (args.length == 1) {
            const url = cfg('URL');
            let dir = cfg('BACKUP_DIR');
            if (url && dir) {
                const edir = `${dir}/${dateStr()}`;
                const filesDir = `${dir}/files`;
                await DocClient.export(url, edir, filesDir);
            } else { usage(); }
        } else if (args.length != 3) { usage(); }
        else { await DocClient.export(args[1], args[2], args[3]); }
    } else if (cmd === 'import') {
        if (args.length != 4) { usage(); }
        const type = args[3];
        if (type === 'merge') { await DocClient.import(args[1], args[2], false); }
        else if (type === 'reset') { await DocClient.import(args[1], args[2], true); }
        else { usage(`expecting 'merge' or 'reset' but found '${type}`); }
    } else if (cmd === 'scheduleBackup') {
        verifyBackupSettings();
        console.log('Scheduling backups to run every night at 2 AM');
        nodeCron.schedule('0 0 2 * * *', performBackup);
    } else if (cmd === 'runBackupDaemon') {
        verifyBackupSettings();
        await runBackupDaemon();
    } else if (cmd === 'delete') {
        if (args.length != 2) { usage(); }
        await DocClient.delete(args[1]);
    } else { usage(`invalid command: '${cmd}'`); }
}

main();
