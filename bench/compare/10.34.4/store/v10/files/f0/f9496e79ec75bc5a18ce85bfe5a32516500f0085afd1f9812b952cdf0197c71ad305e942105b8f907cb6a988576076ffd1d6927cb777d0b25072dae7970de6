import { StrykerOptions } from '@stryker-mutator/api/core';
import { Logger } from '@stryker-mutator/api/logging';
import { Disposable } from 'typed-inject';
export declare class TemporaryDirectory implements Disposable {
    #private;
    private readonly log;
    private readonly options;
    removeDuringDisposal: boolean;
    static readonly inject: ["logger", "options"];
    constructor(log: Logger, options: StrykerOptions);
    initialize(): Promise<void>;
    get path(): string;
    /**
     * Deletes the Stryker-temp directory
     */
    dispose(): Promise<void>;
}
//# sourceMappingURL=temporary-directory.d.ts.map