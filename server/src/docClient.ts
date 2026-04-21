/**
 * Copyright (c) 2024 Discover Financial Services
 */
import axios from 'axios';
import fs from 'fs';
export class DocClient {
    private url: string;
    private auth: any;
    private dir: string;

    /**
     * Export document
     *
     * @param fromUrl - Url of file to export
     * @param toDir - Directory file will be saved to
     */
    public static async export(fromUrl: string, toDir: string) {
        try {
            const dc = new DocClient(fromUrl, toDir);
            await dc.doExport();
        } catch (e: any) {
            console.error(`ERROR: export from ${fromUrl} failed: ${e.stack}`);
        }
    }

    /**
     * Import document
     *
     * @param fromUrl - Url of file to export
     * @param toDir - Directory file will be saved to
     * @param reset - Flag for resetting the database before import
     *
     */
    public static async import(fromDir: string, toUrl: string, reset: boolean) {
        try {
            const dc = new DocClient(toUrl, fromDir);
            await dc.doImport(reset);
        } catch (e: any) {
            console.error(`ERROR: import to ${toUrl} failed: ${e.stack}`);
        }
    }

    constructor(url: string, dir: string) {
        this.url = url;
        this.dir = dir;
        this.auth = {
            username: DocClient.cfg('USER'),
            password: DocClient.cfg('PASS'),
        };
    }

    /**
     * Read a file and parse its contents as JSON.
     *
     * @summary
     * This method reads the contents of a file specified by the `filePath` parameter
     * and attempts to parse the contents as JSON. If the file does not exist or cannot
     * be parsed as JSON, it returns an empty object.
     *
     * @returns {Promise<any>} A Promise that resolves with the parsed JSON object, or an
     * empty object if the file does not exist or cannot be parsed as JSON.
     */
    public async doExport() {
        if (fs.existsSync(this.dir)) {
            throw Error(`Export directory '${this.dir}' already exists`);
        }
        console.log(
            `Starting export from URL '${this.url}' to directory '${this.dir}'`
        );
        fs.mkdirSync(this.dir);
        const idsMap = await this.sendGet('export_ids');
        await this.writeFile(this.mapFile(), idsMap);
        for (const cName of Object.keys(idsMap)) {
            console.log(`Exporting collection ${cName}`);
            const ids = idsMap[cName];
            for (const id of ids) {
                console.log(`Exporting entry ${id}`);
                try {
                    const ele = await this.sendGet(`export/${cName}/${id}`);
                    await this.writeFile(this.eleFile(cName, id), ele);
                } catch (e: any) {
                    console.warn(
                        `WARNING: export of ${id} from collection ${cName} failed: ${e.message}`
                    );
                }
            }
        }
        console.log(
            `Completed export from URL '${this.url}' to directory '${this.dir}'`
        );
    }

    /**
     * Import documents from the specified directory to the target URL.
     *
     * @summary
     * This method is responsible for importing documents from the directory specified
     * by `this.dir` to the target URL (`this.url`). Also logs a message indicating the
     * successful completion of the import process.
     *
     * @param {boolean} reset - A flag indicating whether to reset the target URL before importing.
     */
    public async doImport(reset: boolean) {
        if (!fs.existsSync(this.dir)) {
            throw Error(`Import directory '${this.dir}' does not exist`);
        }
        console.log(
            `Starting import from directory '${this.dir}' to URL '${this.url}'`
        );
        if (reset) {
            await this.sendGet('reset');
        }
        const idsMap: any = await this.readFile(this.mapFile());
        for (const cName of Object.keys(idsMap)) {
            console.log(`Importing collection ${cName}`);
            const ids = idsMap[cName];
            for (const id of ids) {
                console.log(`Importing entry ${id}`);
                const ele = await this.readFile(this.eleFile(cName, id));
                await this.sendPost(`import/${cName}/${id}`, ele);
            }
        }
        console.log(
            `Completed import from directory '${this.dir}' to URL '${this.url}'`
        );
    }

    /** Axios GET */
    private async sendGet(path: string): Promise<any> {
        return await this.sendAxios(path, { method: 'GET' });
    }

    /** Axios POST */
    private async sendPost(path: string, body: object): Promise<any> {
        return await this.sendAxios(path, { method: 'POST', data: body });
    }

    /**
     * Handler to send (POST) and get (GET) files using axios
     *
     * @param path - Directory in which to create the file
     * @param opts - Options
     * @returns Axios response data
     */
    private async sendAxios(path: string, opts?: any): Promise<any> {
        const url = this.makeUrl(path);
        opts = opts || {};
        opts.method = opts.method || 'GET';
        opts.url = url;
        opts.auth = this.auth;
        opts.headers = { 'Content-Type': 'application/json' };
        console.log(`Sending ${JSON.stringify(opts)} ...`);
        try {
            const resp = await axios(opts);
            const obj = resp.data;
            console.log(
                `Response from ${opts.method} ${url}: ${JSON.stringify(obj, null, 4)}`
            );
            return obj;
        } catch (e: any) {
            console.warn(e.message);
            if (e.response && e.response.data) {
                console.warn(e.response.data);
            }
            throw Error(e.message);
        }
    }

    /**
     * Read file content by file name
     *
     * @param name - File name
     * @returns - Contents of file (if file exists and is read) or undefined
     */
    private async readFile(name: string) {
        return JSON.parse(fs.readFileSync(name).toString());
    }

    /**
     * Write file content by file name
     *
     * @param name - File name
     * @param obj - Data to write
     * @returns - Contents of file (if file exists and is read) or undefined
     */
    private async writeFile(name: string, obj: object) {
        fs.writeFileSync(name, JSON.stringify(obj));
    }

    /**
     * Map file location
     *
     * @returns - File location
     */
    private mapFile() {
        return `${this.dir}/export.json`;
    }

    /**
     * Craete filename including location
     *
     * @returns - Filename including location
     */
    private eleFile(cName: string, id: string) {
        return `${this.dir}/${cName}-${id}.json`;
    }

    /**
     * Create admin api path
     *
     * @returns - Create admin api path
     */
    private makeUrl(path: string): string {
        return `${this.url}/api/admin/${path}`;
    }

    /**
     * Retreive environment variable, if it is set
     *
     * @param name - Name of environment variable
     * @param def - Optional default value
     * @returns String of environment variable value
     * or default value
     */
    public static cfg(name: string, def?: string): string {
        const rtn = process.env[name];
        if (!rtn) {
            if (def) {
                return def;
            }
            return DocClient.fatal(`${name} environment variable is not set`);
        }
        return rtn;
    }

    /** Output error
     *
     * @param msg - String of error message
     */
    public static fatal(msg: string): never {
        console.error(`ERROR: ${msg}`);
        process.exit(1);
    }
}
