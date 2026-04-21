/**
 * Copyright (c) 2024 Discover Financial Services
 */
export class DocError extends Error {
    public readonly scode: number;

    constructor(scode: number, msg: string) {
        super(msg);
        this.scode = scode;
    }
}

export function throwErr(scode: number, msg: string): never {
    throw new DocError(scode, msg);
}
