import { LogLevel, PartialStrykerOptions } from '@stryker-mutator/api/core';
import { LoggingEvent } from './logging-event.js';
import { Disposable } from 'typed-inject';
import { LoggingSink } from './logging-sink.js';
/**
 * The logging backend that handles the actual logging. So to both a file and the stdout, stderr.
 */
export declare class LoggingBackend implements LoggingSink, Disposable {
    #private;
    activeStdoutLevel: LogLevel;
    activeFileLevel: LogLevel;
    showColors: boolean;
    static readonly inject: readonly ["loggerConsoleOut"];
    constructor(consoleOut: NodeJS.WritableStream);
    log(event: LoggingEvent): void;
    isEnabled(level: LogLevel): boolean;
    get activeLogLevel(): LogLevel;
    get priority(): 0 | 1 | 2 | 3 | 4 | 5 | 6;
    configure({ logLevel, fileLogLevel, allowConsoleColors, }: PartialStrykerOptions): void;
    dispose(): Promise<void>;
}
//# sourceMappingURL=logging-backend.d.ts.map