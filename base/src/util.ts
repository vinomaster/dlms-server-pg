/**
 * Copyright (c) 2024 Discover Financial Services
 */

/**
 * Format date
 * 
 * @param d number
 * @returns string
 */
export function formatDate(d: number): string {
    if (!d) { return "" }
    var date = new Date(d);
    return (
        ("0" + (date.getMonth() + 1)).slice(-2) + "/" +
        ("0" + date.getDate()).slice(-2) + "/" +
        ("" + date.getFullYear()).slice(-4)
    )
}

/**
 * Format date
 * 
 * @param d number
 * @returns string
 */
export function formatDateTime(d: number): string {
    if (!d) { return "" }
    var date = new Date(d);
    return (
        ("0" + (date.getMonth() + 1)).slice(-2) + "/" +
        ("0" + date.getDate()).slice(-2) + "/" +
        ("" + date.getFullYear()).slice(-4) + " " + date.getHours() + ":" + ("0" + date.getMinutes()).slice(-2)
    )
}

/**
 * Format date
 * 
 * @param d number
 * @returns string
 */
 export function formatDateTimeSeconds(d: number): string {
    if (!d) { return "" }
    var date = new Date(d);
    return (
        ("0" + (date.getMonth() + 1)).slice(-2) + "/" +
        ("0" + date.getDate()).slice(-2) + "/" +
        ("" + date.getFullYear()).slice(-4) + " " + date.getHours() + ":" + ("0" + date.getMinutes()).slice(-2) + ":" + ("0" + date.getSeconds()).slice(-2) + "." + date.getMilliseconds()
    )
}

/**
 * Format the current time as a date and time
 * @returns the current time as a date and time
 */
export function formatNow(): string {
    return formatDateTimeSeconds(Date.now());
}

/**
 * Format a number representing the file size and return as string.  Uses 1000 = 1KB (not 1024)
 * 
 * @param d The file size in bytes
 * @param decimals [Optional] The number of decimal places to display (default=2)
 * @returns string
 */
export function formatFileSize(d: number, decimals?: number): string {
    var fixed = decimals || 2;
    if (d < 1000) fixed = 0;
    var exp = Math.log(Math.abs(d)) / Math.log(1000) | 0;
    var result = (d / Math.pow(1000, exp)).toFixed(fixed);
    return result + ' ' + (exp === 0 ? 'Bytes': 'KMGTPEZY'[exp - 1] + 'B');
}
