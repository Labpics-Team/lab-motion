import type { FileResult, MutantResult } from 'mutation-testing-report-schema';
import type { MetricsResult } from './metrics-result.js';
import { MutantModel } from './mutant-model.js';
import { SourceFile } from './source-file.js';
/**
 * Represents a file which was mutated (your production code).
 */
export declare class FileUnderTestModel extends SourceFile implements FileResult {
    /**
     * Programming language that is used. Used for code highlighting, see https://prismjs.com/#examples.
     */
    language: string;
    /**
     * Full source code of the mutated file, this is used for highlighting.
     */
    source: string;
    /**
     * The mutants inside this file.
     */
    mutants: MutantModel[];
    /**
     * The associated MetricsResult of this file.
     */
    result?: MetricsResult;
    name: string;
    /**
     * @param input The file result content
     * @param name The file name
     */
    constructor(input: FileResult, name: string);
    /**
     * Retrieves the lines of code with the mutant applied to it, to be shown in a diff view.
     */
    getMutationLines(mutant: MutantResult): string;
}
//# sourceMappingURL=file-under-test-model.d.ts.map