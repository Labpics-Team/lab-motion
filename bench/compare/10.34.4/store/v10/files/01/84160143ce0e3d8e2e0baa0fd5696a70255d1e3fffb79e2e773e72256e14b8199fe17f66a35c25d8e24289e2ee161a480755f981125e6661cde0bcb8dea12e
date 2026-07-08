import { Disposable } from '@stryker-mutator/api/plugin';
import { LoggingServerAddress, LoggingSink } from '../logging/index.js';
import { LogLevel } from '@stryker-mutator/api/core';
import { LoggingEvent } from './logging-event.js';
export declare class LoggingClient implements LoggingSink, Disposable {
    #private;
    private logLevel;
    private loggingServerAddress;
    static readonly inject: readonly ["loggerActiveLevel", "loggingServerAddress"];
    constructor(logLevel: LogLevel, loggingServerAddress: LoggingServerAddress);
    openConnection(): Promise<void>;
    log(event: LoggingEvent): void;
    isEnabled(level: LogLevel): boolean;
    dispose(): Promise<void>;
}
//# sourceMappingURL=logging-client.d.ts.map