import { tokens, commonTokens } from '@stryker-mutator/api/plugin';
import { coreTokens } from '../di/index.js';
import { RetryRejectedDecorator } from './retry-rejected-decorator.js';
import { TimeoutDecorator } from './timeout-decorator.js';
import { ChildProcessTestRunnerProxy } from './child-process-test-runner-proxy.js';
import { CommandTestRunner } from './command-test-runner.js';
import { MaxTestRunnerReuseDecorator } from './max-test-runner-reuse-decorator.js';
import { ReloadEnvironmentDecorator } from './reload-environment-decorator.js';
createTestRunnerFactory.inject = tokens(commonTokens.options, commonTokens.fileDescriptions, coreTokens.sandbox, coreTokens.loggingServerAddress, commonTokens.getLogger, coreTokens.pluginModulePaths, coreTokens.workerIdGenerator);
export function createTestRunnerFactory(options, fileDescriptions, sandbox, loggingServerAddress, getLogger, pluginModulePaths, idGenerator) {
    if (CommandTestRunner.is(options.testRunner)) {
        return () => new RetryRejectedDecorator(getLogger(RetryRejectedDecorator.name), () => new TimeoutDecorator(getLogger(TimeoutDecorator.name), () => new CommandTestRunner(sandbox.workingDirectory, options)));
    }
    else {
        return () => new RetryRejectedDecorator(getLogger(RetryRejectedDecorator.name), () => new ReloadEnvironmentDecorator(() => new MaxTestRunnerReuseDecorator(() => new TimeoutDecorator(getLogger(TimeoutDecorator.name), () => new ChildProcessTestRunnerProxy(options, fileDescriptions, sandbox.workingDirectory, loggingServerAddress, pluginModulePaths, getLogger, idGenerator)), options)));
    }
}
//# sourceMappingURL=index.js.map