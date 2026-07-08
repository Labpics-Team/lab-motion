import { TestResult } from '@stryker-mutator/api/test-runner';
import { type RunnerTestSuite } from 'vitest';
import { RunnerTestCase } from 'vitest/node';
import { MutantCoverage } from '@stryker-mutator/api/core';
export declare function convertTestToTestResult(test: RunnerTestCase): TestResult;
export declare function fromTestId(id: string): {
    file: string;
    test: string;
};
export declare function normalizeTestId(id: string): string;
export declare function normalizeCoverage(rawCoverage: MutantCoverage): MutantCoverage;
export declare function collectTestsFromSuite(suite: RunnerTestSuite): RunnerTestCase[];
export declare function isErrorCodeError(error: unknown): error is Error & {
    code: string;
};
/** @see https://github.com/vitest-dev/vitest/blob/main/packages/vitest/src/node/errors.ts */
export declare const VITEST_ERROR_CODES: Readonly<{
    FILES_NOT_FOUND: "VITEST_FILES_NOT_FOUND";
}>;
//# sourceMappingURL=vitest-helpers.d.ts.map