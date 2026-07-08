import { MutantResult, schema, StrykerOptions } from '@stryker-mutator/api/core';
import { Logger } from '@stryker-mutator/api/logging';
import { DryRunCompletedEvent, MutationTestingPlanReadyEvent, Reporter } from '@stryker-mutator/api/report';
import { MutationTestMetricsResult } from 'mutation-testing-metrics';
import { PluginCreator } from '../di/index.js';
import { StrictReporter } from './strict-reporter.js';
export declare class BroadcastReporter implements StrictReporter {
    private readonly options;
    private readonly pluginCreator;
    private readonly log;
    private readonly reporterOverride;
    static readonly inject: ["options", "pluginCreator", "logger", "reporterOverride"];
    readonly reporters: Record<string, Reporter>;
    constructor(options: StrykerOptions, pluginCreator: PluginCreator, log: Logger, reporterOverride: Reporter | undefined);
    private createReporter;
    private logAboutReporters;
    private broadcast;
    onDryRunCompleted(event: DryRunCompletedEvent): void;
    onMutationTestingPlanReady(event: MutationTestingPlanReadyEvent): void;
    onMutantTested(result: MutantResult): void;
    onMutationTestReportReady(report: schema.MutationTestResult, metrics: MutationTestMetricsResult): void;
    wrapUp(): Promise<void>;
    private handleError;
}
//# sourceMappingURL=broadcast-reporter.d.ts.map