import { describe, expect, it } from 'vitest';
import { animate } from '../src/animate/index.js';
import { MotionParamError } from '../src/errors.js';

/**
 * test/animate-layout-optin.test.ts — opt-in контракт Surface-маршрутизатора.
 *
 * Базовый фасад не несёт граф Future Layout; layout:'project' без opt-in —
 * типизированная отказная граница LM173 (никогда silent fallback на прямой
 * tween). После импорта './animate/layout' маршрут регистрируется и поверхность
 * исполняется тем же поведением, что у прежнего bundled-фасада: ни потребитель
 * layout, ни потребитель без него не деградируют.
 *
 * RED-граница: если регистрация в dist-артефакте снова начнёт стираться
 * минификатором (фактический инцидент Terser DCE side-effect модуля),
 * shipped-часть тестов увидит это до потребителя.
 */
describe('animate layout opt-in', () => {
  it('layout:project без регистрации бросает типизированный LM173 до любых побочных эффектов', () => {
    let caught: unknown;
    try {
      animate(
        Object.create(null) as unknown as Element,
        { width: [240, 360] },
        { layout: 'project' } as never,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MotionParamError);
    expect((caught as MotionParamError).code).toBe('LM173');
  });

  it('layout:project со значением, отличным от project, не провоцирует LM173', () => {
    // Консервативная неизменность семантики: не-включённый layout не трогаем.
    let caught: unknown;
    try {
      animate(
        Object.create(null) as unknown as Element,
        { width: [240, 360] },
        { layout: 'other' } as never,
      );
    } catch (error) {
      caught = error;
    }
    // Ошибка обычной валидации ландшафта (цель/канал), но не LM173.
    expect((caught as MotionParamError)?.code ?? '').not.toBe('LM173');
  });

  it('импорт субпутя регистрирует роутер и маркер подтверждает установку', async () => {
    const layout = await import('../src/animate/layout/index.js');
    expect(layout.surfaceLayoutRouter).toBe(true);
    // Повторный вызов без ширинной пары — та же LM173 граница уходит:
    // уже зарегистрированный роутер проваливается консервативно в runtime path.
    let caught: unknown;
    try {
      animate(
        Object.create(null) as unknown as Element,
        { width: [240, 360] },
        { layout: 'project' } as never,
      );
    } catch (error) {
      caught = error;
    }
    expect((caught as MotionParamError)?.code ?? '').not.toBe('LM173');
  });

  it('shipped dist-layout устанавливает роутер (защита от повторного стирания минификатором)', async () => {
    const layout = await import('../dist/animate/layout/index.js');
    expect(layout.surfaceLayoutRouter).toBe(true);
  });

  it('shipped dist CJS-вариант layout устанавливает роутер', async () => {
    const layout = await import('../dist/animate/layout/index.cjs');
    expect(layout.surfaceLayoutRouter).toBe(true);
  });
});
