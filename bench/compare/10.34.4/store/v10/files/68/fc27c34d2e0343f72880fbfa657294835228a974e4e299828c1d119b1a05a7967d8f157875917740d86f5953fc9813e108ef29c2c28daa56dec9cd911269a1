import treeKill from 'tree-kill';
import { StrykerError } from '@stryker-mutator/util';
export const objectUtils = {
    /**
     * Calls a defined callback function on each element of a map, and returns an array that contains the results.
     *
     * @param subject The map to act on
     * @param callbackFn The callback fn
     * @returns
     */
    map(subject, callbackFn) {
        const results = [];
        subject.forEach((value, key) => results.push(callbackFn(value, key)));
        return results;
    },
    /**
     * A wrapper around `process.env` (for testability)
     */
    getEnvironmentVariable(nameEnvironmentVariable) {
        return process.env[nameEnvironmentVariable];
    },
    undefinedEmptyString(str) {
        if (str) {
            return str;
        }
        return undefined;
    },
    getEnvironmentVariableOrThrow(name) {
        const value = this.getEnvironmentVariable(name);
        if (value === undefined) {
            throw new StrykerError(`Missing environment variable "${name}"`);
        }
        else {
            return value;
        }
    },
    isWarningEnabled(warningType, warningOptions) {
        if (typeof warningOptions === 'boolean') {
            return warningOptions;
        }
        else {
            return !!warningOptions[warningType];
        }
    },
    /**
     * A wrapper around `process.exitCode = n` (for testability)
     */
    setExitCode(n) {
        process.exitCode = n;
    },
    kill(pid) {
        return new Promise((res, rej) => {
            treeKill(pid, 'SIGKILL', (err) => {
                if (err && !canIgnore(err.code)) {
                    rej(err);
                }
                else {
                    res();
                }
            });
            function canIgnore(code) {
                // https://docs.microsoft.com/en-us/windows/desktop/Debug/system-error-codes--0-499-
                // these error codes mean the program is _already_ closed.
                return code === 255 || code === 128;
            }
        });
    },
    /**
     * Converts an internal StrykerJS 0-based location to a schema.Location (1-based).
     * @param location the StrykerJS 0-based location
     * @returns the schema.Location (1-based)
     */
    toSchemaLocation(location) {
        return {
            end: this.toSchemaPosition(location.end),
            start: this.toSchemaPosition(location.start),
        };
    },
    /**
     * Converts an internal StrykerJS 0-based position to a schema.Position (1-based).
     * @param pos the StrykerJS 0-based position
     * @returns the schema.Position (1-based)
     */
    toSchemaPosition(pos) {
        return {
            column: pos.column + 1,
            line: pos.line + 1,
        };
    },
};
//# sourceMappingURL=object-utils.js.map