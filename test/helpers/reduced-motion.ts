export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Query-sensitive matchMedia seam for reduced-motion tests.
 *
 * A fixed `matches` fake is an invalid oracle: it cannot distinguish the real
 * prefers-reduced-motion query from an arbitrary media query. This helper makes
 * the query part of the observable contract and optionally records every read.
 */
export function reducedMotionMedia(
  reduced: boolean,
  queries?: string[],
): (query: string) => MediaQueryList {
  return (query: string): MediaQueryList => {
    queries?.push(query);
    return {
      matches: query === REDUCED_MOTION_QUERY ? reduced : false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    };
  };
}
