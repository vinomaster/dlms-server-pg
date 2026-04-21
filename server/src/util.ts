/**
 * Copyright (c) 2024 Discover Financial Services
 */

/**
 * Sleep
 * 
 * @param duration - The number of ms to sleep
 * @returns 
 */
export const sleep = (duration: number) => new Promise((resolve) => setTimeout(resolve, duration));

/**
 * Returns the methods associated with any object
 *
 * @param obj Object - to get methods from
 * @returns The methods associated with any object
 */
export function getMethods(obj: any): any {
    const properties = new Set();
    let currentObj = obj;
    do {
        Object.getOwnPropertyNames(currentObj).forEach(item =>
            properties.add(item)
        );
    } while ((currentObj = Object.getPrototypeOf(currentObj)));
    return [...properties.keys()].filter(
        (item: any) => typeof obj[item] === 'function'
    );
}

/**
 * Create error with specified code and message
 *
 * @param scode
 * @param msg
 */
export function throwErr(scode: number, msg: string): never {
    throw new DocMgrError(scode, msg);
}

/**
 * Get field based on path and an object
 *
 * @param path - The path / field name
 * @param obj - The object to get the field from
 * @returns Field object or error
 */
export function getField(path: string, obj: any): any {
    const parts = path.split('.');
    for (const part of parts) {
        if (!(part in obj)) {
            return throwErr(
                400,
                `Field '${part} not found in ${JSON.stringify(obj)}`
            );
        }
        obj = obj[part];
    }
    return obj;
}

/** Custom error class for document manager */
export class DocMgrError extends Error {
    public readonly scode: number;

    constructor(scode: number, msg: string) {
        super(msg);
        this.scode = scode;
    }
}
