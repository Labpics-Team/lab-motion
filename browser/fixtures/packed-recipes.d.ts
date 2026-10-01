/** Только type boundary артефакта globalSetup; runtime загружает actual tarball. */
export declare const captureSmart: typeof import('../../src/smart/index.js').captureSmart;
export declare const createPresenceTransition: typeof import('../../src/presence/index.js').createPresenceTransition;
export declare const animate: typeof import('../../src/animate/index.js').animate;
export declare const createReorder: typeof import('../../src/behaviors/reorder/index.js').createReorder;
export declare const CompositorSpring: typeof import('../../src/compositor/index.js').CompositorSpring;
export declare function bindAnimatedDialog(dialog: HTMLDialogElement): {
    setPresent(present: boolean): Promise<unknown>;
    readonly finished: Promise<unknown>;
    readonly state: string;
    destroy(): void;
  };
