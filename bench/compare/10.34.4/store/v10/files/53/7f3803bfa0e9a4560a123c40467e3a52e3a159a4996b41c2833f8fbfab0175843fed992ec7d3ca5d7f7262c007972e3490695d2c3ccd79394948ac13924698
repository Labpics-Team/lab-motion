import { INSTRUMENTER_CONSTANTS, StrykerOptions } from '@stryker-mutator/api/core';
import { Logger } from '@stryker-mutator/api/logging';
import { Injector, PluginContext } from '@stryker-mutator/api/plugin';
import { TestRunner, DryRunResult, MutantRunOptions, MutantRunResult, TestRunnerCapabilities, DryRunOptions } from '@stryker-mutator/api/test-runner';
type StrykerNamespace = '__stryker__' | '__stryker2__';
export declare class VitestTestRunner implements TestRunner {
    private readonly log;
    private globalNamespace;
    static inject: readonly ["options", "logger", "globalNamespace"];
    private ctx?;
    private readonly options;
    private localSetupFile;
    constructor(options: StrykerOptions, log: Logger, globalNamespace: StrykerNamespace);
    capabilities(): TestRunnerCapabilities;
    init(): Promise<void>;
    dryRun(options: DryRunOptions): Promise<DryRunResult>;
    mutantRun(options: MutantRunOptions): Promise<MutantRunResult>;
    private run;
    private setEnv;
    private resetContext;
    private readHitCount;
    private readMutantCoverage;
    dispose(): Promise<void>;
}
export declare const vitestTestRunnerFactory: {
    (injector: Injector<PluginContext>): VitestTestRunner;
    inject: ["$injector"];
};
export declare function createVitestTestRunnerFactory(namespace?: typeof INSTRUMENTER_CONSTANTS.NAMESPACE | '__stryker2__'): {
    (injector: Injector<PluginContext>): VitestTestRunner;
    inject: ['$injector'];
};
export {};
//# sourceMappingURL=vitest-test-runner.d.ts.map