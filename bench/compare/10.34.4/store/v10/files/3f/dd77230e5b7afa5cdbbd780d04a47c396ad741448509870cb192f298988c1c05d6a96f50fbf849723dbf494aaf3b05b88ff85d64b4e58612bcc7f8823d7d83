import path from 'path';
import fs from 'fs';
import { commonTokens, tokens } from '@stryker-mutator/api/plugin';
export class TemporaryDirectory {
    log;
    options;
    #temporaryDirectory;
    removeDuringDisposal;
    static inject = tokens(commonTokens.logger, commonTokens.options);
    constructor(log, options) {
        this.log = log;
        this.options = options;
        this.removeDuringDisposal = Boolean(options.cleanTempDir);
    }
    async initialize() {
        const parent = path.resolve(this.options.tempDirName);
        await fs.promises.mkdir(parent, { recursive: true });
        this.#temporaryDirectory = await fs.promises.mkdtemp(path.join(parent, this.options.inPlace ? 'backup-' : 'sandbox-'));
        this.log.debug('Using temp directory "%s"', this.#temporaryDirectory);
    }
    get path() {
        if (!this.#temporaryDirectory) {
            this.#throwNotInitialized();
        }
        return this.#temporaryDirectory;
    }
    #throwNotInitialized() {
        throw new Error('initialize() was not called!');
    }
    /**
     * Deletes the Stryker-temp directory
     */
    async dispose() {
        if (this.removeDuringDisposal && this.#temporaryDirectory) {
            this.log.debug('Deleting stryker temp directory %s', this.#temporaryDirectory);
            try {
                await fs.promises.rm(this.#temporaryDirectory, {
                    recursive: true,
                    force: true,
                });
            }
            catch {
                this.log.info(`Failed to delete stryker temp directory ${this.#temporaryDirectory}`);
            }
            try {
                const lingeringDirectories = await fs.promises.readdir(this.options.tempDirName);
                if (!lingeringDirectories.length) {
                    try {
                        await fs.promises.rmdir(this.options.tempDirName);
                    }
                    catch (e) {
                        // It's not THAT important, maybe another StrykerJS process started in the meantime.
                        this.log.debug(`Failed to clean temp ${path.basename(this.options.tempDirName)}`, e);
                    }
                }
            }
            catch {
                // Can safely be ignored, the parent directory doesn't exist
            }
        }
    }
}
//# sourceMappingURL=temporary-directory.js.map