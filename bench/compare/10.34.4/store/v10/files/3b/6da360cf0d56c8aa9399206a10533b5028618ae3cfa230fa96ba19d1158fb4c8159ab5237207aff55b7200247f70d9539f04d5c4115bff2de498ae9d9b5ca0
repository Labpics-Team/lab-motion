import { commonTokens, Scope } from '@stryker-mutator/api/plugin';
import { LoggerImpl } from './logger-impl.js';
import { coreTokens } from '../di/index.js';
import { LoggingServer } from './logging-server.js';
import { LoggingBackend } from './logging-backend.js';
import { LoggingClient } from './logging-client.js';
function getLoggerFactory(loggingSink) {
    return (categoryName) => new LoggerImpl(categoryName ?? 'UNKNOWN', loggingSink);
}
getLoggerFactory.inject = [coreTokens.loggingSink];
function loggerFactory(getLogger, 
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
target) {
    return getLogger(target?.name);
}
loggerFactory.inject = [commonTokens.getLogger, commonTokens.target];
export function provideLogging(injector) {
    return injector
        .provideFactory(commonTokens.getLogger, getLoggerFactory)
        .provideFactory(commonTokens.logger, loggerFactory, Scope.Transient)
        .provideClass('loggingServer', LoggingServer);
}
provideLogging.inject = [
    coreTokens.loggingSink,
    commonTokens.injector,
];
export async function provideLoggingBackend(injector, loggerConsoleOut) {
    const out = injector
        .provideValue(coreTokens.loggerConsoleOut, loggerConsoleOut)
        .provideClass(coreTokens.loggingSink, LoggingBackend)
        .provideClass(coreTokens.loggingServer, LoggingServer);
    const loggingServer = out.resolve(coreTokens.loggingServer);
    const loggingServerAddress = await loggingServer.listen();
    return out.provideValue(coreTokens.loggingServerAddress, loggingServerAddress);
}
provideLoggingBackend.inject = [commonTokens.injector];
export async function provideLoggingClient(injector, loggingServerAddress, activeLogLevel) {
    const out = injector
        .provideValue(coreTokens.loggingServerAddress, loggingServerAddress)
        .provideValue(coreTokens.loggerActiveLevel, activeLogLevel)
        .provideClass(coreTokens.loggingSink, LoggingClient);
    await out.resolve(coreTokens.loggingSink).openConnection();
    return out;
}
//# sourceMappingURL=provide-logging.js.map