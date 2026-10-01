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

interface CompositorRecipeOptions {
  motion?: 'auto' | 'none';
  onSelect?: (index: number) => void;
  requestFrame?: NonNullable<ConstructorParameters<typeof CompositorSpring>[0]['requestFrame']>;
}

interface CompositorRecipeControls {
  motion: InstanceType<typeof CompositorSpring>;
  select(index: number): void;
  readonly selected: number;
  pause(): void;
  resume(): void;
  destroy(): void;
}

export declare function mountCardMotion(root: HTMLElement): () => void;
export declare function mountCompositorSheet(root: HTMLElement, options: CompositorRecipeOptions & {
  snapPoints: readonly number[];
}): CompositorRecipeControls & { resize(next: readonly number[]): void };
export declare function mountCompositorPager(root: HTMLElement, options?: CompositorRecipeOptions):
  CompositorRecipeControls & { resize(): void };
export declare function mountReorder(root: HTMLElement, status: HTMLElement): () => void;
export declare function mountReact(container: Element | Document | DocumentFragment, hydrate?: boolean): {
  destroy(): void;
  commits(): number;
};
export declare function mountSolid(container: Parameters<typeof import('solid-js/web').render>[1]): () => void;
