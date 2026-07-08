import { Command } from 'commander';
import { PartialStrykerOptions } from '@stryker-mutator/api/core';
import { StrykerServerOptions } from './stryker-server.js';
import { createInjector } from 'typed-inject';
export declare class StrykerCli {
    #private;
    private readonly argv;
    private readonly program;
    private readonly runMutationTest;
    private readonly runMutationTestingServer;
    constructor(argv: string[], program?: Command, runMutationTest?: (options: PartialStrykerOptions) => Promise<import("@stryker-mutator/api/core").MutantResult[]>, runMutationTestingServer?: (serverOptions: StrykerServerOptions, cliStrykerOptions: PartialStrykerOptions) => Promise<number | undefined>);
    run(createInjectorImpl?: typeof createInjector): void;
}
export declare function guardMinimalNodeVersion(processVersion?: string): void;
//# sourceMappingURL=stryker-cli.d.ts.map