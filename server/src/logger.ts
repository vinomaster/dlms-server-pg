/**
 * Copyright (c) 2024 Discover Financial Services
 */
import { formatNow } from 'dlms-base';

export enum LogLevel {
    Critical = 0,
    Error = 1,
    Warn = 2,
    Info = 3,
    Trace = 4,
    Debug = 5,
}

interface NameValue {
    name: string;
    value: LogLevel;
}

const levels: NameValue[] = [
    { name: 'CRITICAL', value: LogLevel.Critical },
    { name: 'ERROR', value: LogLevel.Error },
    { name: 'WARNING', value: LogLevel.Warn },
    { name: 'INFO', value: LogLevel.Info },
    { name: 'TRACE', value: LogLevel.Trace },
    { name: 'DEBUG', value: LogLevel.Debug },
];

const defaultLogLevel = nameToLevel(process.env.DLMS_LOG_LEVEL);

/**
 * Translate name of level to level object
 *
 * @param name - Name of level
 * @returns LogLevel object
 */
function nameToLevel(name?: string): LogLevel {
    name = (name || 'INFO').toUpperCase();
    for (const level of levels) {
        if (level.name == name) {
            return level.value;
        }
    }
    throw new Error(
        `'${name}' is an invalid DLMS_LOG_LEVEL value; expecting one of ${JSON.stringify(names())}`
    );
}

/**
 * Retrieve a list of the names of the log levels
 *
 * @returns Array of names
 */
function names(): string[] {
    return levels.map(nv => nv.name);
}

/**
 * Retrieve log level object from the log level name
 *
 * @param level - LogLevel object
 * @returns Name of level
 */
function levelToName(level: LogLevel): string {
    return levels[level].name;
}

export class Logger {
    public readonly name: string;
    public level: LogLevel;

    constructor(name: string, level?: LogLevel) {
        this.name = name;
        this.level = level || defaultLogLevel;
    }

    public err(...msg: any[]) {
        if (LogLevel.Error <= this.level) {
            console.log.apply(console, [
                ...[
                    `${formatNow()} ${levelToName(LogLevel.Error)} ${this.name}`,
                ],
                ...msg,
            ]);
        }
    }

    public warn(...msg: any[]) {
        if (LogLevel.Warn <= this.level) {
            console.log.apply(console, [
                ...[
                    `${formatNow()} ${levelToName(LogLevel.Warn)} ${this.name}`,
                ],
                ...msg,
            ]);
        }
    }

    public info(...msg: any[]) {
        if (LogLevel.Info <= this.level) {
            console.log.apply(console, [
                ...[
                    `${formatNow()} ${levelToName(LogLevel.Info)} ${this.name}`,
                ],
                ...msg,
            ]);
        }
    }

    public trace(...msg: any[]) {
        if (LogLevel.Trace <= this.level) {
            console.log.apply(console, [
                ...[
                    `${formatNow()} ${levelToName(LogLevel.Trace)} ${this.name}`,
                ],
                ...msg,
            ]);
        }
    }

    public debug(...msg: any[]) {
        if (LogLevel.Debug <= this.level) {
            console.log.apply(console, [
                ...[
                    `${formatNow()} ${levelToName(LogLevel.Debug)} ${this.name}`,
                ],
                ...msg,
            ]);
        }
    }
}
