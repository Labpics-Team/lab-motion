/**
 * test/lit-element-template.test.ts
 * Class: A (unit) — LabMotionSpringElement `template` placeholder substitution.
 *
 * `renderTemplateValue()` is the pure logic extracted from
 * `LabMotionSpringElement._applyStyle()` (src/lit/element.ts): it is
 * DOM-free by construction, so it is testable directly under vitest's
 * `environment: 'node'` config — no jsdom/happy-dom devDependency needed
 * (LitElement itself requires a real DOM and is intentionally NOT
 * instantiated anywhere in this test suite; see lit-api-surface-pin.test.ts).
 *
 * ── RED PROOF ──────────────────────────────────────────────────────────────
 * Revert `replaceAll('{v}', ...)` back to `replace('{v}', ...)` in
 * renderTemplateValue() → the composite-template test (`'translate({v}px,
 * {v}px)'`) fails: the second `{v}` is left as a literal, unparseable string
 * in the emitted CSS value instead of being substituted.
 */

import { describe, expect, it } from 'vitest';
import { renderTemplateValue } from '../src/lit/element.js';

describe('renderTemplateValue (LabMotionSpringElement template substitution)', () => {
  it('substitutes a single {v} placeholder', () => {
    expect(renderTemplateValue('{v}', 0.5)).toBe('0.5');
    expect(renderTemplateValue('translateX({v}px)', 42)).toBe('translateX(42px)');
  });

  it('substitutes EVERY occurrence in a composite template (not just the first)', () => {
    // This is the exact example documented at the top of element.ts as a
    // supported usage — a single-occurrence replace() silently breaks it.
    expect(renderTemplateValue('translate({v}px, {v}px)', 10)).toBe('translate(10px, 10px)');
  });

  it('templates without {v} ignore the template and emit the value as a plain string', () => {
    expect(renderTemplateValue('opacity', 0.75)).toBe('0.75');
  });

  it('handles negative and fractional values inside a composite template', () => {
    expect(renderTemplateValue('scale({v}, {v})', -1.5)).toBe('scale(-1.5, -1.5)');
  });
});
