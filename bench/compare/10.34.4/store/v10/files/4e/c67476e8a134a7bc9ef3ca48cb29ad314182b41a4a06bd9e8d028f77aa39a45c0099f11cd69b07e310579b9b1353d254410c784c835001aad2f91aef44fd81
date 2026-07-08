import { DiscoverParams, DiscoverResult, ConfigureParams, ConfigureResult, MutationTestParams } from 'mutation-server-protocol';
import { createInjector } from 'typed-inject';
import { Observable } from 'rxjs';
import { MutantResult, PartialStrykerOptions } from '@stryker-mutator/api/core';
export declare const rpcMethods: Readonly<{
    configure: "configure";
    discover: "discover";
    mutationTest: "mutationTest";
    reportMutationTestProgressNotification: "reportMutationTestProgress";
}>;
export interface StrykerServerOptions {
    channel: 'stdio' | 'socket';
    port?: number;
    address?: string;
}
/**
 * An implementation of the mutation testing server protocol for StrykerJS.
 * - Methods: `initialize`, `discover`, `mutationTest`
 *
 * @see https://github.com/stryker-mutator/editor-plugins/tree/main/packages/mutation-server-protocol#readme
 */
export declare class StrykerServer {
    #private;
    /**
     * @param cliOptions The cli options.
     * @param serverOptions The server options.
     * @param injectorFactory The injector factory, for testing purposes only
     */
    constructor(serverOptions: StrykerServerOptions, cliOptions?: PartialStrykerOptions, injectorFactory?: typeof createInjector);
    /**
     * Starts the server and listens for incoming connections.
     * @returns The port the server is listening on, or undefined if the server is listening on stdio.
     */
    start(): Promise<number | undefined>;
    stop(): Promise<void>;
    configure(configureParams: ConfigureParams): ConfigureResult;
    discover(discoverParams: DiscoverParams): Promise<DiscoverResult>;
    mutationTest(mutationTestParams: MutationTestParams): Observable<MutantResult>;
}
//# sourceMappingURL=stryker-server.d.ts.map