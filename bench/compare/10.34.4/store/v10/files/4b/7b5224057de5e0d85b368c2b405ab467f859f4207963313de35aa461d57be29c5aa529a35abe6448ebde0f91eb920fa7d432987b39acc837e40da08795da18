import { coreTokens } from '../di/index.js';
import { LoggingEvent } from './logging-event.js';
import net from 'node:net';
import { promisify } from 'node:util';
export const DELIMITER = '__STRYKER_CORE__';
export class LoggingServer {
    loggingSink;
    static inject = [coreTokens.loggingSink];
    #server;
    constructor(loggingSink) {
        this.loggingSink = loggingSink;
        this.#server = net.createServer((socket) => {
            socket.setEncoding('utf-8');
            let dataSoFar = '';
            socket.on('data', (data) => {
                dataSoFar += data;
                let index;
                while ((index = dataSoFar.indexOf(DELIMITER)) !== -1) {
                    const logEvent = JSON.parse(dataSoFar.substring(0, index));
                    dataSoFar = dataSoFar.substring(index + DELIMITER.length);
                    this.loggingSink.log(LoggingEvent.deserialize(logEvent));
                }
            });
            socket.on('error', (error) => {
                this.loggingSink.log(LoggingEvent.create(LoggingServer.name, "debug" /* LogLevel.Debug */, [
                    'An worker log process hung up unexpectedly',
                    error,
                ]));
            });
        });
    }
    listen() {
        return new Promise((res) => {
            this.#server.listen(() => {
                res({ port: this.#server.address().port });
            });
        });
    }
    async dispose() {
        await promisify(this.#server.close).bind(this.#server)();
    }
}
//# sourceMappingURL=logging-server.js.map