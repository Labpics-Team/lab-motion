/**
 * test/future-layout-compiler.test.ts — compiler lowering и erasure.
 *
 * Спека: «COMPILER», «RUNTIME БЕЗ COMPILER»; RED-Фаза п.20 (Compiler graph
 * содержит solver/parser/full facade) и п.21-смежный seam: lowering
 * layout:'project' в versioned surface program ещё не существует.
 *
 * RED PROOF (история): до GREEN src/compiler/core.ts умел только
 * nano-lowering; seam `lowerSurfaceCall` отсутствовал — pick-хелпер
 * возвращал undefined, тест падал СВОИМ ассертом
 * (канон test/animate-facade-helpers.ts:9-31).
 * GREEN: seam добавлен (conservative lowering, каждый guard с positive
 * control в test/future-layout-compiler-lowering.test.ts).
 * Erasure-гарантии (нет solver/parser/full facade в compiled consumer graph) —
 * acceptance-ассерты scripts/compiler-acceptance.mjs (surface no-op секция).
 */

import { describe, expect, it } from 'vitest';
import * as compiler from '../src/compiler/core.js';

const mod = compiler as unknown as Record<string, unknown>;

describe('compiler: lowering animate(..., { layout: "project" })', () => {
  it('RED п.20: lowering-seam surface-вызова существует и консервативен', () => {
    const lowerSurfaceCall = mod['lowerSurfaceCall'] as
      | ((input: unknown) => { lowered: boolean; reason?: string })
      | undefined;
    expect(typeof lowerSurfaceCall).toBe('function');

    // Positive control: статический вызов с literal-аргументами понижается.
    const staticCall = lowerSurfaceCall!({
      callee: 'animate',
      target: { kind: 'identifier', name: 'viewport' },
      props: { width: [240, 360] },
      options: { layout: 'project', spring: { mass: 1, stiffness: 170, damping: 26 } },
    });
    expect(staticCall.lowered).toBe(true);

    // Conservative guards: сомнение оставляет runtime path.
    const dynamicWidth = lowerSurfaceCall!({
      callee: 'animate',
      target: { kind: 'identifier', name: 'viewport' },
      props: { width: [{ kind: 'identifier', name: 'w0' }, 360] },
      options: { layout: 'project' },
    });
    expect(dynamicWidth.lowered).toBe(false);

    const dynamicLayout = lowerSurfaceCall!({
      callee: 'animate',
      target: { kind: 'identifier', name: 'viewport' },
      props: { width: [240, 360] },
      options: { layout: { kind: 'identifier', name: 'mode' } },
    });
    expect(dynamicLayout.lowered).toBe(false);
  });
});
