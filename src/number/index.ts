/**
 * number presets — AnimateNumber-like with Intl for locale/currency/unit.
 * SSR-safe (Intl is universal), reduced-motion passed through, perf: formatter cached per call site pattern.
 * Drive-based for consistent easing + policy.
 */

import { animate, type AnimateOptions } from '../animate.js';

export interface NumberFormatOptions {
  locales?: string | string[];
  format?: Intl.NumberFormatOptions;
}

function makeFormatter(opts: NumberFormatOptions): Intl.NumberFormat {
  const { locales = 'en-US', format } = opts;
  return new Intl.NumberFormat(locales, format);
}

/** Format a value once using Intl (for snapshots / final). */
export function formatNumber(value: number, opts: NumberFormatOptions = {}): string {
  return makeFormatter(opts).format(value);
}

/** Animate a number, emitting Intl-formatted strings on each step. */
export function animateNumber(
  from: number,
  to: number,
  onUpdate: (formatted: string) => void,
  options: Omit<AnimateOptions, 'from' | 'to' | 'onStep'> & NumberFormatOptions = {} as any
): Promise<void> {
  const fmt = makeFormatter(options);
  return animate({
    from,
    to,
    ...options,
    onStep: (v: number) => {
      // Guard: drive already ensures finite; format only finite
      onUpdate(fmt.format(v));
    },
  });
}
