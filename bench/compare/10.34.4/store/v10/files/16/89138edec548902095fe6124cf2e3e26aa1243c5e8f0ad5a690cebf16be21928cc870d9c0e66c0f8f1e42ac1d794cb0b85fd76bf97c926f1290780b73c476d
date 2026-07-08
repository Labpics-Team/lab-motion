/**
 * Use named imports to improve tree-shaking capabilities.
 */
import { type z } from 'zod';
export declare const ConfigureParams: z.ZodObject<{
    configFilePath: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type ConfigureParams = z.infer<typeof ConfigureParams>;
export declare const ConfigureResult: z.ZodObject<{
    version: z.ZodString;
}, z.core.$strip>;
export type ConfigureResult = z.infer<typeof ConfigureResult>;
export declare const Location: z.ZodObject<{
    start: z.ZodObject<{
        line: z.ZodNumber;
        column: z.ZodNumber;
    }, z.core.$strip>;
    end: z.ZodObject<{
        line: z.ZodNumber;
        column: z.ZodNumber;
    }, z.core.$strip>;
}, z.core.$strip>;
export type Location = z.infer<typeof Location>;
/**
 * Represents a file or directory and an optional range within that file.
 */
export declare const FileRange: z.ZodObject<{
    path: z.ZodString;
    range: z.ZodOptional<z.ZodObject<{
        start: z.ZodObject<{
            line: z.ZodNumber;
            column: z.ZodNumber;
        }, z.core.$strip>;
        end: z.ZodObject<{
            line: z.ZodNumber;
            column: z.ZodNumber;
        }, z.core.$strip>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type FileRange = z.infer<typeof FileRange>;
export declare const DiscoverParams: z.ZodObject<{
    files: z.ZodOptional<z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        range: z.ZodOptional<z.ZodObject<{
            start: z.ZodObject<{
                line: z.ZodNumber;
                column: z.ZodNumber;
            }, z.core.$strip>;
            end: z.ZodObject<{
                line: z.ZodNumber;
                column: z.ZodNumber;
            }, z.core.$strip>;
        }, z.core.$strip>>;
    }, z.core.$strip>>>;
}, z.core.$strip>;
export type DiscoverParams = z.infer<typeof DiscoverParams>;
export declare const DiscoveredMutant: z.ZodObject<{
    id: z.ZodString;
    location: z.ZodObject<{
        start: z.ZodObject<{
            line: z.ZodNumber;
            column: z.ZodNumber;
        }, z.core.$strip>;
        end: z.ZodObject<{
            line: z.ZodNumber;
            column: z.ZodNumber;
        }, z.core.$strip>;
    }, z.core.$strip>;
    description: z.ZodOptional<z.ZodString>;
    mutatorName: z.ZodString;
    replacement: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type DiscoveredMutant = z.infer<typeof DiscoveredMutant>;
export declare const DiscoveredFile: z.ZodObject<{
    mutants: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        location: z.ZodObject<{
            start: z.ZodObject<{
                line: z.ZodNumber;
                column: z.ZodNumber;
            }, z.core.$strip>;
            end: z.ZodObject<{
                line: z.ZodNumber;
                column: z.ZodNumber;
            }, z.core.$strip>;
        }, z.core.$strip>;
        description: z.ZodOptional<z.ZodString>;
        mutatorName: z.ZodString;
        replacement: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type DiscoveredFile = z.infer<typeof DiscoveredFile>;
export declare const DiscoveredFiles: z.ZodRecord<z.ZodString, z.ZodObject<{
    mutants: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        location: z.ZodObject<{
            start: z.ZodObject<{
                line: z.ZodNumber;
                column: z.ZodNumber;
            }, z.core.$strip>;
            end: z.ZodObject<{
                line: z.ZodNumber;
                column: z.ZodNumber;
            }, z.core.$strip>;
        }, z.core.$strip>;
        description: z.ZodOptional<z.ZodString>;
        mutatorName: z.ZodString;
        replacement: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>>;
export type DiscoveredFiles = z.infer<typeof DiscoveredFiles>;
export declare const DiscoverResult: z.ZodObject<{
    files: z.ZodRecord<z.ZodString, z.ZodObject<{
        mutants: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            location: z.ZodObject<{
                start: z.ZodObject<{
                    line: z.ZodNumber;
                    column: z.ZodNumber;
                }, z.core.$strip>;
                end: z.ZodObject<{
                    line: z.ZodNumber;
                    column: z.ZodNumber;
                }, z.core.$strip>;
            }, z.core.$strip>;
            description: z.ZodOptional<z.ZodString>;
            mutatorName: z.ZodString;
            replacement: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type DiscoverResult = z.infer<typeof DiscoverResult>;
/**
 * The specific targets to run mutation testing on, or if both properties are left undefined: run mutation testing on all files in the current project.
 * Only one of the two properties should be set.
 * If both properties are set, the `mutants` property takes precedence.
 */
export declare const MutationTestParams: z.ZodObject<{
    files: z.ZodOptional<z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        range: z.ZodOptional<z.ZodObject<{
            start: z.ZodObject<{
                line: z.ZodNumber;
                column: z.ZodNumber;
            }, z.core.$strip>;
            end: z.ZodObject<{
                line: z.ZodNumber;
                column: z.ZodNumber;
            }, z.core.$strip>;
        }, z.core.$strip>>;
    }, z.core.$strip>>>;
    mutants: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        mutants: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            location: z.ZodObject<{
                start: z.ZodObject<{
                    line: z.ZodNumber;
                    column: z.ZodNumber;
                }, z.core.$strip>;
                end: z.ZodObject<{
                    line: z.ZodNumber;
                    column: z.ZodNumber;
                }, z.core.$strip>;
            }, z.core.$strip>;
            description: z.ZodOptional<z.ZodString>;
            mutatorName: z.ZodString;
            replacement: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strip>>>;
}, z.core.$strip>;
export type MutationTestParams = z.infer<typeof MutationTestParams>;
declare const MutantStatus: z.ZodEnum<{
    Killed: "Killed";
    Survived: "Survived";
    NoCoverage: "NoCoverage";
    CompileError: "CompileError";
    RuntimeError: "RuntimeError";
    Timeout: "Timeout";
    Ignored: "Ignored";
    Pending: "Pending";
}>;
export type MutantStatus = z.infer<typeof MutantStatus>;
export declare const MutantResult: z.ZodObject<{
    id: z.ZodString;
    location: z.ZodObject<{
        start: z.ZodObject<{
            line: z.ZodNumber;
            column: z.ZodNumber;
        }, z.core.$strip>;
        end: z.ZodObject<{
            line: z.ZodNumber;
            column: z.ZodNumber;
        }, z.core.$strip>;
    }, z.core.$strip>;
    description: z.ZodOptional<z.ZodString>;
    mutatorName: z.ZodString;
    replacement: z.ZodOptional<z.ZodString>;
    coveredBy: z.ZodOptional<z.ZodArray<z.ZodString>>;
    duration: z.ZodOptional<z.ZodNumber>;
    killedBy: z.ZodOptional<z.ZodArray<z.ZodString>>;
    static: z.ZodOptional<z.ZodBoolean>;
    status: z.ZodEnum<{
        Killed: "Killed";
        Survived: "Survived";
        NoCoverage: "NoCoverage";
        CompileError: "CompileError";
        RuntimeError: "RuntimeError";
        Timeout: "Timeout";
        Ignored: "Ignored";
        Pending: "Pending";
    }>;
    statusReason: z.ZodOptional<z.ZodString>;
    testsCompleted: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export type MutantResult = z.infer<typeof MutantResult>;
export declare const MutantResultFile: z.ZodObject<{
    mutants: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        location: z.ZodObject<{
            start: z.ZodObject<{
                line: z.ZodNumber;
                column: z.ZodNumber;
            }, z.core.$strip>;
            end: z.ZodObject<{
                line: z.ZodNumber;
                column: z.ZodNumber;
            }, z.core.$strip>;
        }, z.core.$strip>;
        description: z.ZodOptional<z.ZodString>;
        mutatorName: z.ZodString;
        replacement: z.ZodOptional<z.ZodString>;
        coveredBy: z.ZodOptional<z.ZodArray<z.ZodString>>;
        duration: z.ZodOptional<z.ZodNumber>;
        killedBy: z.ZodOptional<z.ZodArray<z.ZodString>>;
        static: z.ZodOptional<z.ZodBoolean>;
        status: z.ZodEnum<{
            Killed: "Killed";
            Survived: "Survived";
            NoCoverage: "NoCoverage";
            CompileError: "CompileError";
            RuntimeError: "RuntimeError";
            Timeout: "Timeout";
            Ignored: "Ignored";
            Pending: "Pending";
        }>;
        statusReason: z.ZodOptional<z.ZodString>;
        testsCompleted: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type MutantResultFile = z.infer<typeof MutantResultFile>;
export declare const MutationResultFiles: z.ZodRecord<z.ZodString, z.ZodObject<{
    mutants: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        location: z.ZodObject<{
            start: z.ZodObject<{
                line: z.ZodNumber;
                column: z.ZodNumber;
            }, z.core.$strip>;
            end: z.ZodObject<{
                line: z.ZodNumber;
                column: z.ZodNumber;
            }, z.core.$strip>;
        }, z.core.$strip>;
        description: z.ZodOptional<z.ZodString>;
        mutatorName: z.ZodString;
        replacement: z.ZodOptional<z.ZodString>;
        coveredBy: z.ZodOptional<z.ZodArray<z.ZodString>>;
        duration: z.ZodOptional<z.ZodNumber>;
        killedBy: z.ZodOptional<z.ZodArray<z.ZodString>>;
        static: z.ZodOptional<z.ZodBoolean>;
        status: z.ZodEnum<{
            Killed: "Killed";
            Survived: "Survived";
            NoCoverage: "NoCoverage";
            CompileError: "CompileError";
            RuntimeError: "RuntimeError";
            Timeout: "Timeout";
            Ignored: "Ignored";
            Pending: "Pending";
        }>;
        statusReason: z.ZodOptional<z.ZodString>;
        testsCompleted: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
}, z.core.$strip>>;
export type MutationResultFiles = z.infer<typeof MutationResultFiles>;
export declare const MutationTestResult: z.ZodObject<{
    files: z.ZodRecord<z.ZodString, z.ZodObject<{
        mutants: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            location: z.ZodObject<{
                start: z.ZodObject<{
                    line: z.ZodNumber;
                    column: z.ZodNumber;
                }, z.core.$strip>;
                end: z.ZodObject<{
                    line: z.ZodNumber;
                    column: z.ZodNumber;
                }, z.core.$strip>;
            }, z.core.$strip>;
            description: z.ZodOptional<z.ZodString>;
            mutatorName: z.ZodString;
            replacement: z.ZodOptional<z.ZodString>;
            coveredBy: z.ZodOptional<z.ZodArray<z.ZodString>>;
            duration: z.ZodOptional<z.ZodNumber>;
            killedBy: z.ZodOptional<z.ZodArray<z.ZodString>>;
            static: z.ZodOptional<z.ZodBoolean>;
            status: z.ZodEnum<{
                Killed: "Killed";
                Survived: "Survived";
                NoCoverage: "NoCoverage";
                CompileError: "CompileError";
                RuntimeError: "RuntimeError";
                Timeout: "Timeout";
                Ignored: "Ignored";
                Pending: "Pending";
            }>;
            statusReason: z.ZodOptional<z.ZodString>;
            testsCompleted: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type MutationTestResult = z.infer<typeof MutationTestResult>;
export {};
//# sourceMappingURL=schema.d.ts.map