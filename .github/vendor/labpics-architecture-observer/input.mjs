import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';

// Input paths are data, not streams or executable configuration. Validate again
// on the descriptor so a path swap cannot turn the size check into a FIFO read.
export function readRegularFile(file, maxBytes = 1024 * 1024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
        throw new TypeError('Invalid input size budget');
    if (typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_NONBLOCK !== 'number')
        throw new Error('Safe input requires no-follow and nonblocking file flags on this platform');
    const before = lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink())
        throw new Error('Input must be a regular file, not a symlink or stream');
    if (before.size > maxBytes)
        throw new Error('Input exceeds size budget');
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
            throw new Error('Input must remain the same regular file');
        if (opened.size > maxBytes)
            throw new Error('Input exceeds size budget');
        const chunks = [];
        let total = 0;
        while (true) {
            const buffer = Buffer.allocUnsafe(Math.min(65536, maxBytes - total + 1));
            const count = readSync(fd, buffer, 0, buffer.length, null);
            if (!count)
                break;
            total += count;
            if (total > maxBytes)
                throw new Error('Input exceeds size budget');
            chunks.push(buffer.subarray(0, count));
        }
        return Buffer.concat(chunks, total);
    } finally {
        closeSync(fd);
    }
}

export function parseJsonData(source) {
    try {
        return JSON.parse(source);
    } catch (error) {
        if (error instanceof SyntaxError)
            throw new TypeError('Invalid JSON input; source bytes omitted');
        throw error;
    }
}
