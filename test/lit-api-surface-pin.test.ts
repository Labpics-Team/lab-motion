/**
 * test/lit-api-surface-pin.test.ts
 * Class: Б (contract pin — старое не сломалось / API contract characterization)
 *
 * Пин публичной поверхности ./lit — точный набор runtime-экспортов и форма
 * MotionController / LabMotionSpringElement зафиксированы. Добавление/удаление/
 * переименование ломает CI.
 *
 * ── RED PROOF ──────────────────────────────────────────────────────────────
 * Убрать `export { MotionController }` из src/lit/index.ts →
 *   `expect(exported).toContain('MotionController')` падает.
 * Переименовать метод `setTarget` в MotionController →
 *   `'setTarget' in controller` → RED.
 * Убрать `LAB_MOTION_SPRING_TAG` из экспортов →
 *   `expect(exported).toContain('LAB_MOTION_SPRING_TAG')` падает.
 * Добавить неконтрактный экспорт →
 *   `extra` test-case падает.
 *
 * НЕ инстанцирует и НЕ подключает LabMotionSpringElement к реальному DOM
 * (vitest environment: 'node' — нет document/window; lit-html рендер требует
 * реального document, которого здесь нет). Проверяет только форму класса —
 * ту же гарантию, что api-surface-pin тесты дают остальным subpath-ам.
 */

import { describe, expect, it } from 'vitest';
import * as litModule from '../src/lit/index.js';
import { MotionController } from '../src/lit/controller.js';
import { LabMotionSpringElement, LAB_MOTION_SPRING_TAG } from '../src/lit/element.js';

// Ровно те runtime-значения, которые экспортирует ./lit (типы стираются).
const EXPECTED_EXPORTS = new Set(['MotionController', 'LabMotionSpringElement', 'LAB_MOTION_SPRING_TAG']);

describe('./lit public API surface pin (инвариант 6)', () => {
  it('экспортирует ровно контрактные имена — ни больше, ни меньше', () => {
    const exported = new Set(Object.keys(litModule));

    const missing = [...EXPECTED_EXPORTS].filter((name) => !exported.has(name));
    expect(missing, `Отсутствующие экспорты: ${missing.join(', ')}`).toHaveLength(0);

    const extra = [...exported].filter((name) => !EXPECTED_EXPORTS.has(name));
    expect(extra, `Неконтрактные новые экспорты: ${extra.join(', ')}`).toHaveLength(0);
  });

  it('MotionController — функция (класс)', () => {
    expect(typeof MotionController).toBe('function');
  });

  it('LabMotionSpringElement — функция (класс)', () => {
    expect(typeof LabMotionSpringElement).toBe('function');
  });

  it('LAB_MOTION_SPRING_TAG — непустая строка', () => {
    expect(typeof LAB_MOTION_SPRING_TAG).toBe('string');
    expect(LAB_MOTION_SPRING_TAG.length).toBeGreaterThan(0);
  });
});

describe('MotionController: форма контракта', () => {
  function makeFakeHost() {
    return {
      addController: () => {},
      removeController: () => {},
      requestUpdate: () => {},
      updateComplete: Promise.resolve(true),
    };
  }

  it('конструктор принимает (host, initial, options?) и возвращает объект', () => {
    const c = new MotionController(makeFakeHost(), 0);
    expect(c).toBeTruthy();
    expect(typeof c).toBe('object');
  });

  it('value — читаемое числовое свойство', () => {
    const c = new MotionController(makeFakeHost(), 5);
    expect(typeof c.value).toBe('number');
    expect(c.value).toBe(5);
  });

  it('setTarget — функция', () => {
    const c = new MotionController(makeFakeHost(), 0);
    expect(typeof c.setTarget).toBe('function');
  });

  it('hostConnected — функция (Lit ReactiveController lifecycle)', () => {
    const c = new MotionController(makeFakeHost(), 0);
    expect(typeof c.hostConnected).toBe('function');
  });

  it('hostDisconnected — функция (Lit ReactiveController lifecycle)', () => {
    const c = new MotionController(makeFakeHost(), 0);
    expect(typeof c.hostDisconnected).toBe('function');
  });

  it('host.addController вызывается конструктором', () => {
    let called = false;
    const host = { ...makeFakeHost(), addController: () => { called = true; } };
    new MotionController(host, 0);
    expect(called).toBe(true);
  });
});

describe('LabMotionSpringElement: форма класса (без подключения к DOM)', () => {
  it('static properties объявляет target/property/template', () => {
    const props = LabMotionSpringElement.properties as Record<string, unknown>;
    expect(props).toBeTruthy();
    expect('target' in props).toBe(true);
    expect('property' in props).toBe(true);
    expect('template' in props).toBe(true);
  });

  it('прототип объявляет render/updated/connectedCallback как функции', () => {
    const proto = LabMotionSpringElement.prototype as unknown as Record<string, unknown>;
    expect(typeof proto['render']).toBe('function');
    expect(typeof proto['updated']).toBe('function');
    expect(typeof proto['connectedCallback']).toBe('function');
  });
});
