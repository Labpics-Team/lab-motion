import net from 'net';
import { promisify } from 'util';
import { DELIMITER } from './logging-server.js';
import { logLevelPriority } from './priority.js';
import { coreTokens } from '../di/index.js';
export class LoggingClient {
    logLevel;
    loggingServerAddress;
    #socket;
    static inject = [
        coreTokens.loggerActiveLevel,
        coreTokens.loggingServerAddress,
    ];
    constructor(logLevel, loggingServerAddress) {
        this.logLevel = logLevel;
        this.loggingServerAddress = loggingServerAddress;
    }
    openConnection() {
        return new Promise((res, rej) => {
            this.#socket = net.createConnection(this.loggingServerAddress.port, 'localhost', res);
            this.#socket.on('error', (error) => {
                console.error('Error occurred in logging client', error);
                rej(error);
            });
        });
    }
    log(event) {
        if (!this.#socket) {
            throw new Error(`Cannot use the logging client before it is connected, please call '${LoggingClient.name}.prototype.${LoggingClient.prototype.openConnection.name}' first`);
        }
        if (this.isEnabled(event.level) && this.#socket.writable) {
            this.#socket.write(JSON.stringify(event.serialize()) + DELIMITER);
        }
    }
    isEnabled(level) {
        return logLevelPriority[level] >= logLevelPriority[this.logLevel];
    }
    async dispose() {
        if (this.#socket) {
            await promisify(this.#socket.end).bind(this.#socket)();
        }
    }
}
//# sourceMappingURL=logging-client.js.map