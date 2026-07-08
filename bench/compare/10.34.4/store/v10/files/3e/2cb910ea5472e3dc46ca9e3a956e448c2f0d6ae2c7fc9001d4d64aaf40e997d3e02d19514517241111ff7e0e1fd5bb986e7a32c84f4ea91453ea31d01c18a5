import { LoggingEvent } from './logging-event.js';
export class LoggerImpl {
    #categoryName;
    #loggingBackend;
    constructor(categoryName, loggingBackend) {
        this.#categoryName = categoryName;
        this.#loggingBackend = loggingBackend;
    }
    isTraceEnabled() {
        return this.#loggingBackend.isEnabled("trace" /* LogLevel.Trace */);
    }
    isDebugEnabled() {
        return this.#loggingBackend.isEnabled("debug" /* LogLevel.Debug */);
    }
    isInfoEnabled() {
        return this.#loggingBackend.isEnabled("info" /* LogLevel.Information */);
    }
    isWarnEnabled() {
        return this.#loggingBackend.isEnabled("warn" /* LogLevel.Warning */);
    }
    isErrorEnabled() {
        return this.#loggingBackend.isEnabled("error" /* LogLevel.Error */);
    }
    isFatalEnabled() {
        return this.#loggingBackend.isEnabled("fatal" /* LogLevel.Fatal */);
    }
    trace(message, ...args) {
        this.#loggingBackend.log(LoggingEvent.create(this.#categoryName, "trace" /* LogLevel.Trace */, [
            message,
            ...args,
        ]));
    }
    debug(message, ...args) {
        this.#loggingBackend.log(LoggingEvent.create(this.#categoryName, "debug" /* LogLevel.Debug */, [
            message,
            ...args,
        ]));
    }
    info(message, ...args) {
        this.#loggingBackend.log(LoggingEvent.create(this.#categoryName, "info" /* LogLevel.Information */, [
            message,
            ...args,
        ]));
    }
    warn(message, ...args) {
        this.#loggingBackend.log(LoggingEvent.create(this.#categoryName, "warn" /* LogLevel.Warning */, [
            message,
            ...args,
        ]));
    }
    error(message, ...args) {
        this.#loggingBackend.log(LoggingEvent.create(this.#categoryName, "error" /* LogLevel.Error */, [
            message,
            ...args,
        ]));
    }
    fatal(message, ...args) {
        this.#loggingBackend.log(LoggingEvent.create(this.#categoryName, "fatal" /* LogLevel.Fatal */, [
            message,
            ...args,
        ]));
    }
}
//# sourceMappingURL=logger-impl.js.map