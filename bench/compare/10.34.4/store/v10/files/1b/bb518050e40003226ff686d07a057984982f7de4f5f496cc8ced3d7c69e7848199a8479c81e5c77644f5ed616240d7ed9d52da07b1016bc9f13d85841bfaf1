import { DryRunResult, DryRunOptions, MutantRunResult, MutantRunOptions, TestRunner } from '@stryker-mutator/api/test-runner';
import { TestRunnerDecorator } from './test-runner-decorator.js';
import { Logger } from '@stryker-mutator/api/logging';
export declare const MAX_RETRIES = 2;
/**
 * Implements the retry functionality whenever an internal test runner rejects a promise.
 */
export declare class RetryRejectedDecorator extends TestRunnerDecorator {
    readonly log: Logger;
    constructor(log: Logger, producer: () => TestRunner);
    dryRun(options: DryRunOptions): Promise<DryRunResult>;
    mutantRun(options: MutantRunOptions): Promise<MutantRunResult>;
    private run;
}
//# sourceMappingURL=retry-rejected-decorator.d.ts.map