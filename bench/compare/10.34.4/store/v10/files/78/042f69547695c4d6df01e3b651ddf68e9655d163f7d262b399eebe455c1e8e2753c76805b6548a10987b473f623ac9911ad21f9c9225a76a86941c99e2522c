import { Injector } from 'typed-inject';
import { LoggingSink } from './logging-sink.js';
import { Logger } from '@stryker-mutator/api/logging';
import { coreTokens } from '../di/index.js';
import { LoggingServer, LoggingServerAddress } from './logging-server.js';
import { LoggingBackend } from './logging-backend.js';
import { LoggingClient } from './logging-client.js';
import { LogLevel } from '@stryker-mutator/api/core';
export declare function provideLogging<T extends {
    [coreTokens.loggingSink]: LoggingSink;
}>(injector: Injector<T>): Injector<{ [K_1 in "loggingServer" | "getLogger" | "logger" | keyof T]: K_1 extends "loggingServer" ? LoggingServer : K_1 extends "getLogger" | "logger" | keyof T ? ({ [K_4 in "getLogger" | "logger" | keyof T]: K_4 extends "logger" ? Logger : K_4 extends "getLogger" | keyof T ? ({ [K_6 in "getLogger" | keyof T]: K_6 extends "getLogger" ? (categoryName?: string) => Logger : K_6 extends keyof T ? T[K_6] : never; } extends infer T_3 ? { [K_5 in keyof T_3]: T_3[K_5]; } : never)[K_4] : never; } extends infer T_2 ? { [K_3 in keyof T_2]: T_2[K_3]; } : never)[K_1] : never; } extends infer T_1 ? { [K in keyof T_1]: T_1[K]; } : never>;
export declare namespace provideLogging {
    var inject: readonly ["loggingSink", "$injector"];
}
export declare function provideLoggingBackend(injector: Injector, loggerConsoleOut: NodeJS.WriteStream): Promise<Injector<{
    loggingServerAddress: LoggingServerAddress;
    loggerConsoleOut: NodeJS.WriteStream;
    loggingSink: LoggingBackend;
    loggingServer: LoggingServer;
}>>;
export declare namespace provideLoggingBackend {
    var inject: readonly ["$injector"];
}
export type LoggingProvider = ReturnType<typeof provideLogging>;
export declare function provideLoggingClient(injector: Injector, loggingServerAddress: LoggingServerAddress, activeLogLevel: LogLevel): Promise<Injector<{
    loggingServerAddress: LoggingServerAddress;
    loggerActiveLevel: LogLevel;
    loggingSink: LoggingClient;
}>>;
//# sourceMappingURL=provide-logging.d.ts.map