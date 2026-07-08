import type { TestFile as TestFile } from 'mutation-testing-report-schema';
import type { MetricsResult } from './metrics-result.js';
import { SourceFile } from './source-file.js';
import type { TestMetrics } from './test-metrics.js';
import { TestModel } from './test-model.js';
/**
 * Represents a file that contains tests
 */
export declare class TestFileModel extends SourceFile implements TestFile {
    tests: TestModel[];
    source: string | undefined;
    /**
     * The associated MetricsResult of this file.
     */
    result?: MetricsResult<TestFileModel, TestMetrics>;
    name: string;
    /**
     * @param input the test file content
     * @param name the file name
     */
    constructor(input: TestFile, name: string);
}
//# sourceMappingURL=test-file-model.d.ts.map