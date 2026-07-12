/** Минимальный платформенный контракт для headless reduced-motion API. */
export interface MediaQueryResult {
  readonly matches: boolean;
}

/** Совместим с window.matchMedia, но не требует lib.dom у потребителя. */
export type MatchMediaLike = (query: string) => MediaQueryResult;
