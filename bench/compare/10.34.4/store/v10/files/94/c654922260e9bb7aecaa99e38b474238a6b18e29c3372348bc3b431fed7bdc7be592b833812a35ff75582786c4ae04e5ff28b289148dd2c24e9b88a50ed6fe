import type { MutantCoverage } from '@stryker-mutator/api/core';
import type { MutantActivation } from '@stryker-mutator/api/test-runner';
declare module 'vitest' {
    interface ProvidedContext {
        globalNamespace: '__stryker__' | '__stryker2__';
        hitLimit: number | undefined;
        mutantActivation: MutantActivation;
        activeMutant: string | undefined;
        mode: 'mutant' | 'dry-run';
        isGreaterThanVitest4Point1: boolean;
    }
    interface TaskMeta {
        hitCount: number | undefined;
        mutantCoverage: MutantCoverage | undefined;
    }
}
//# sourceMappingURL=stryker-setup.d.ts.map