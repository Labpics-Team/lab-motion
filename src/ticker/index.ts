/**
 * ticker presets — rolling counter / odometer sugar.
 * Reuses number + animate for perf and consistency. SSR + reduced-motion safe.
 * Minimal: drives value and provides digit array for UI "ticker" cells.
 */

import { animate, type AnimateOptions } from '../animate.js';
import { formatNumber, type NumberFormatOptions } from '../number/index.js';

export interface TickerOptions extends AnimateOptions, NumberFormatOptions {
  /** If true, emit {value, digits} where digits are per-place for ticker cells. */
  asDigits?: boolean;
}

export interface TickerStep {
  value: number;
  formatted: string;
  digits?: string[];
}

/** Drive a ticker value; onUpdate receives formatted (and optional digits). */
export function ticker(
  from: number,
  to: number,
  onUpdate: (step: TickerStep) => void,
  options: Omit<TickerOptions, 'from' | 'to' | 'onStep'> = {} as any
): Promise<void> {
  const { asDigits = false, ...rest } = options;
  const fmtOpts: NumberFormatOptions = { locales: options.locales, format: options.format };
  return animate({
    from,
    to,
    ...rest,
    onStep: (v: number) => {
      const formatted = formatNumber(v, fmtOpts);
      let digits: string[] | undefined;
      if (asDigits) {
        // Split to digit chars (sign/decimal kept simple for cells)
        digits = Array.from(formatted.replace(/[^\d.,-]/g, '')); // keep numeric glyphs
      }
      onUpdate({ value: v, formatted, digits });
    },
  });
}
