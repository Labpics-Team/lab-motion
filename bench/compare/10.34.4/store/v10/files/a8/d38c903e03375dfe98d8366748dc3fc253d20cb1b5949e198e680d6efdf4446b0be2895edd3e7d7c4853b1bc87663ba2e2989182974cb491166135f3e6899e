import { FileDescriptions, StrykerOptions } from '@stryker-mutator/api/core';
import { LoggerFactoryMethod } from '@stryker-mutator/api/logging';
import { TestRunner, DryRunOptions, MutantRunOptions, MutantRunResult, DryRunResult, TestRunnerCapabilities } from '@stryker-mutator/api/test-runner';
import { LoggingServerAddress } from '../logging/index.js';
import { IdGenerator } from '../child-proxy/id-generator.js';
/**
 * Runs the given test runner in a child process and forwards reports about test results
 */
export declare class ChildProcessTestRunnerProxy implements TestRunner {
    private readonly worker;
    private readonly log;
    constructor(options: StrykerOptions, fileDescriptions: FileDescriptions, sandboxWorkingDirectory: string, loggingServerAddress: LoggingServerAddress, pluginModulePaths: readonly string[], getLogger: LoggerFactoryMethod, idGenerator: IdGenerator);
    capabilities(): Promise<TestRunnerCapabilities>;
    init(): Promise<void>;
    dryRun(options: DryRunOptions): Promise<DryRunResult>;
    mutantRun(options: MutantRunOptions): Promise<MutantRunResult>;
    dispose(): Promise<void>;
}
//# sourceMappingURL=child-process-test-runner-proxy.d.ts.map