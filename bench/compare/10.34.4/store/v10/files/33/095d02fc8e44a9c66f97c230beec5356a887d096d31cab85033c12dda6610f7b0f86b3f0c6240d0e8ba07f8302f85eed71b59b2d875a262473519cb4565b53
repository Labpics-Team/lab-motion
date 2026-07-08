import util from 'util';
const pattern = [
    '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)',
    '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))',
].join('|');
const ansiRegex = new RegExp(pattern, 'g');
export class LoggingEvent {
    startTime;
    categoryName;
    data;
    level;
    pid;
    constructor(categoryName, level, data, startTime, pid) {
        this.startTime = startTime;
        this.categoryName = categoryName;
        this.data = data;
        this.level = level;
        this.pid = pid;
    }
    static create(categoryName, level, data) {
        return new LoggingEvent(categoryName, level, data, new Date(), process.pid);
    }
    format() {
        return `${this.#formatPrefix()} ${this.#formatMessage().replace(ansiRegex, '')}`;
    }
    formatColorized() {
        return `${this.#colorizedStart()}${this.#formatPrefix()}${this.#colorizedEnd()} ${this.#formatMessage()}`;
    }
    #formatPrefix() {
        return `${this.startTime.toTimeString().slice(0, 8)} (${this.pid}) ${this.level.toUpperCase()} ${this.categoryName}`;
    }
    #formatMessage() {
        return util.format(...this.data);
    }
    #colorizedStart() {
        return `\x1B[${styles[this.level]}m`;
    }
    #colorizedEnd() {
        return '\x1B[39m';
    }
    static deserialize(ser) {
        return new LoggingEvent(ser.categoryName, ser.level, [ser.message], new Date(ser.startTime), ser.pid);
    }
    serialize() {
        return {
            startTime: this.startTime.toJSON(),
            categoryName: this.categoryName,
            message: this.#formatMessage(),
            level: this.level,
            pid: this.pid,
        };
    }
}
const styles = Object.freeze({
    trace: 34, // blue
    debug: 36, // cyan
    info: 32, // green
    warn: 33, // yellow
    error: 91, // red
    fatal: 35, // magenta
    off: 90, // grey
});
//# sourceMappingURL=logging-event.js.map