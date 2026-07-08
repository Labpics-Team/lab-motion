import { LoggingSink } from './logging-sink.js';
import { Disposable } from '@stryker-mutator/api/plugin';
export interface LoggingServerAddress {
    port: number;
}
export declare const DELIMITER = "__STRYKER_CORE__";
export declare class LoggingServer implements Disposable {
    #private;
    private readonly loggingSink;
    static readonly inject: readonly ["loggingSink"];
    constructor(loggingSink: LoggingSink);
    listen(): Promise<LoggingServerAddress>;
    dispose(): Promise<void>;
}
//# sourceMappingURL=logging-server.d.ts.map