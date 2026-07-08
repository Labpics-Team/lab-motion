import { LogLevel } from '@stryker-mutator/api/core';
export declare class LoggingEvent {
    #private;
    readonly startTime: Date;
    readonly categoryName: string;
    readonly data: Array<unknown>;
    readonly level: LogLevel;
    readonly pid: number;
    private constructor();
    static create(categoryName: string, level: LogLevel, data: Array<unknown>): LoggingEvent;
    format(): string;
    formatColorized(): string;
    static deserialize(ser: SerializedLoggingEvent): LoggingEvent;
    serialize(): SerializedLoggingEvent;
}
export interface SerializedLoggingEvent {
    startTime: string;
    categoryName: string;
    message: string;
    level: LogLevel;
    pid: number;
}
//# sourceMappingURL=logging-event.d.ts.map