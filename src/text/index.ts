/**
 * text presets — DX sugar for text animations.
 * Built on animate()/drive + tokens. SSR-safe (no globals), reduced-motion via opts.
 * Perf: O(n) per update, minimal allocs, seeded RNG for determinism (tests + replay).
 */

import { animate, type AnimateOptions } from '../animate.js';

export type SplitMode = 'chars' | 'words';

/** Split text for staggered reveals. Unicode-safe for chars. */
export function splitText(text: string, mode: SplitMode = 'chars'): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  if (mode === 'words') {
    return text.split(/(\s+)/).filter(Boolean);
  }
  return Array.from(text);
}

/** Typewriter: progressively reveals chars/words via onUpdate. */
export function typewriter(
  text: string,
  onUpdate: (partial: string) => void,
  options: Omit<AnimateOptions, 'from' | 'to' | 'onStep'> & { mode?: SplitMode } = {} as any
): Promise<void> {
  const { mode = 'chars', ...rest } = options;
  const parts = splitText(text, mode);
  if (parts.length === 0) {
    onUpdate('');
    return Promise.resolve();
  }
  return animate({
    from: 0,
    to: parts.length,
    ...(rest as any),
    onStep: (n: number) => {
      const k = Math.max(0, Math.min(parts.length, Math.floor(n)));
      onUpdate(parts.slice(0, k).join(''));
    },
  });
}

/** Simple mulberry32 seeded RNG — deterministic, tiny, no deps. */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Scramble: morphs text toward target with seeded noise for stable replays. */
export function scramble(
  text: string,
  onUpdate: (scrambled: string) => void,
  options: Omit<AnimateOptions, 'from' | 'to' | 'onStep'> & { seed?: number; alphabet?: string } = {} as any
): Promise<void> {
  const seed = (options as any).seed ?? 0xdeadbeef;
  const alphabet = (options as any).alphabet ?? 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const rng = mulberry32(seed);
  const target = Array.from(text);
  const len = target.length;
  if (len === 0) {
    onUpdate('');
    return Promise.resolve();
  }
  // Drive progress 0..1 ; at t=1 exact target
  return animate({
    from: 0,
    to: 1,
    ...(options as any),
    onStep: (t: number) => {
      const reveal = Math.floor(t * len);
      const out: string[] = [];
      for (let i = 0; i < len; i++) {
        if (i < reveal) {
          out.push(target[i]);
        } else {
          // deterministic scramble char from seeded rng
          const idx = Math.floor(rng() * alphabet.length);
          out.push(alphabet[idx]);
        }
      }
      onUpdate(out.join(''));
    },
  });
}
