import { KnownKeys } from '@stryker-mutator/util';
import { Location, Position, schema, WarningOptions } from '@stryker-mutator/api/core';
export declare const objectUtils: {
    /**
     * Calls a defined callback function on each element of a map, and returns an array that contains the results.
     *
     * @param subject The map to act on
     * @param callbackFn The callback fn
     * @returns
     */
    map<K, V, R>(subject: Map<K, V>, callbackFn: (value: V, key: K) => R): R[];
    /**
     * A wrapper around `process.env` (for testability)
     */
    getEnvironmentVariable(nameEnvironmentVariable: string): string | undefined;
    undefinedEmptyString(str: string | undefined): string | undefined;
    getEnvironmentVariableOrThrow(name: string): string;
    isWarningEnabled(warningType: KnownKeys<WarningOptions>, warningOptions: WarningOptions | boolean): boolean;
    /**
     * A wrapper around `process.exitCode = n` (for testability)
     */
    setExitCode(n: number): void;
    kill(pid: number | undefined): Promise<void>;
    /**
     * Converts an internal StrykerJS 0-based location to a schema.Location (1-based).
     * @param location the StrykerJS 0-based location
     * @returns the schema.Location (1-based)
     */
    toSchemaLocation(location: Location): schema.Location;
    /**
     * Converts an internal StrykerJS 0-based position to a schema.Position (1-based).
     * @param pos the StrykerJS 0-based position
     * @returns the schema.Position (1-based)
     */
    toSchemaPosition(pos: Position): schema.Position;
};
//# sourceMappingURL=object-utils.d.ts.map