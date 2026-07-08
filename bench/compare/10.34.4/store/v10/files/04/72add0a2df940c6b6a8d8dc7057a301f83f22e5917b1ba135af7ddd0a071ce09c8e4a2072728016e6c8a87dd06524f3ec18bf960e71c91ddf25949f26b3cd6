import os from 'os';
import { ReplaySubject, range } from 'rxjs';
import { tokens } from 'typed-inject';
import { commonTokens } from '@stryker-mutator/api/plugin';
export class ConcurrencyTokenProvider {
    log;
    concurrencyCheckers;
    concurrencyTestRunners;
    testRunnerTokenSubject = new ReplaySubject();
    get testRunnerToken$() {
        return this.testRunnerTokenSubject;
    }
    checkerToken$;
    static inject = tokens(commonTokens.options, commonTokens.logger);
    constructor(options, log) {
        this.log = log;
        const availableParallelism = os.availableParallelism();
        const concurrency = this.computeConcurrency(options.concurrency, availableParallelism);
        if (options.checkers.length > 0) {
            this.concurrencyCheckers = Math.max(Math.ceil(concurrency / 2), 1);
            this.checkerToken$ = range(this.concurrencyCheckers);
            this.concurrencyTestRunners = Math.max(Math.floor(concurrency / 2), 1);
            log.info('Creating %s checker process(es) and %s test runner process(es).', this.concurrencyCheckers, this.concurrencyTestRunners);
        }
        else {
            this.concurrencyCheckers = 0;
            this.checkerToken$ = range(1); // at least one checker, the `CheckerFacade` will not create worker process.
            this.concurrencyTestRunners = concurrency;
            log.info('Creating %s test runner process(es).', this.concurrencyTestRunners);
        }
        Array.from({ length: this.concurrencyTestRunners }).forEach(() => this.testRunnerTokenSubject.next(this.tick()));
    }
    computeConcurrency(concurrencyOption, availableParallelism) {
        if (typeof concurrencyOption === 'string') {
            const percentageMatch = concurrencyOption.match(/^(100|[1-9]?[0-9])%$/);
            if (percentageMatch) {
                const percentage = parseInt(percentageMatch[1], 10);
                const computed = Math.max(1, Math.round((availableParallelism * percentage) / 100));
                this.log.debug('Computed concurrency %s from "%s" based on %s available parallelism.', computed, concurrencyOption, availableParallelism);
                return computed;
            }
        }
        if (typeof concurrencyOption === 'number') {
            return concurrencyOption;
        }
        // Default: n-1 for n > 4, else n
        return availableParallelism > 4
            ? availableParallelism - 1
            : availableParallelism;
    }
    freeCheckers() {
        if (this.concurrencyCheckers > 0) {
            this.log.debug('Checking done, creating %s additional test runner process(es)', this.concurrencyCheckers);
            for (let i = 0; i < this.concurrencyCheckers; i++) {
                this.testRunnerTokenSubject.next(this.tick());
            }
            this.testRunnerTokenSubject.complete();
        }
    }
    count = 0;
    tick() {
        return this.count++;
    }
    dispose() {
        this.testRunnerTokenSubject.complete();
    }
}
//# sourceMappingURL=concurrency-token-provider.js.map