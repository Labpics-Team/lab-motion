import { MutantResult, PartialStrykerOptions } from '@stryker-mutator/api/core';
import { createInjector, Injector } from 'typed-inject';
import { PrepareExecutorContext, PrepareExecutorArgs } from './process/index.js';
import { coreTokens } from './di/index.js';
import { LoggingBackend } from './logging/index.js';
type MutationRunContext = PrepareExecutorContext & {
    [coreTokens.loggingSink]: LoggingBackend;
};
/**
 * The main Stryker class.
 * It provides a single `runMutationTest()` function which runs mutation testing:
 */
export declare class Stryker {
    private readonly cliOptions;
    private readonly injectorFactory;
    /**
     * @constructor
     * @param cliOptions The cli options.
     * @param injectorFactory The injector factory, for testing purposes only
     */
    constructor(cliOptions: PartialStrykerOptions, injectorFactory?: typeof createInjector);
    runMutationTest(): Promise<MutantResult[]>;
    /**
     * Does the actual mutation testing.
     * Note: this is a public static method, so it can be reused from `StrykerServer`
     * @internal
     */
    static run(mutationRunInjector: Injector<MutationRunContext>, args: PrepareExecutorArgs): Promise<MutantResult[]>;
}
export {};
//# sourceMappingURL=stryker.d.ts.map