import { PartialStrykerOptions } from '@stryker-mutator/api/core';
import { BaseContext, Injector } from '@stryker-mutator/api/plugin';
import { coreTokens } from '../di/index.js';
import { MutantInstrumenterContext } from './index.js';
import { Reporter } from '@stryker-mutator/api/report';
import { LoggingBackend, LoggingServerAddress } from '../logging/index.js';
export interface PrepareExecutorContext extends BaseContext {
    [coreTokens.loggingServerAddress]: LoggingServerAddress;
    [coreTokens.reporterOverride]?: Reporter;
}
export interface PrepareExecutorArgs {
    cliOptions: PartialStrykerOptions;
    targetMutatePatterns: string[] | undefined;
}
export declare class PrepareExecutor {
    private readonly injector;
    private readonly loggingBackend;
    static readonly inject: ["$injector", "loggingSink"];
    constructor(injector: Injector<PrepareExecutorContext>, loggingBackend: LoggingBackend);
    execute({ cliOptions, targetMutatePatterns, }: PrepareExecutorArgs): Promise<Injector<MutantInstrumenterContext>>;
}
//# sourceMappingURL=1-prepare-executor.d.ts.map