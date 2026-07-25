/**
 * time-units-contract.test.ts — ЕДИНИЦЫ ВРЕМЕНИ как машинный контракт.
 *
 * ЗАЧЕМ. Пакет живёт в ДВУХ системах единиц, и это не небрежность, а следствие
 * архитектуры:
 *   • фасадный ярус (`./animate`, `./nano`, `./compositor`, `./compiler`,
 *     `./stagger`) отдаёт тайминги прямо в WAAPI/CSS — там МИЛЛИСЕКУНДЫ;
 *   • физический ярус (`./spring`, `./timeline`, `./keyframes`, `./presets`,
 *     `./gestures`, `./scroll`, `./behaviors`, `./auto`, `./waapi`-компилятор)
 *     считает в СИ вместе с солвером пружины — там СЕКУНДЫ.
 *
 * Цена ошибки — ×1000 и НИ ОДНОГО исключения: `createTimeline` с сегментом
 * `duration: 500` даст 500 секунд, `animate(el, {...}, {duration: 0.5})` —
 * полмиллисекунды. Оба числа физически валидны, поэтому ни валидатор, ни типы
 * ничего не скажут.
 *
 * Аудит 2026-07-25 нашёл, что при этом:
 *   • docs/getting-started.md обещал МИЛЛИСЕКУНДЫ для ВСЕХ публичных опций —
 *     и тут же, десятью строками ниже, показывал `fromBounce({duration: 0.5})`
 *     в секундах;
 *   • 19 из 52 публичных полей со временем не называли единицу вовсе, а часть
 *     остальных называла её в шапке интерфейса — то есть не там, где всплывает
 *     подсказка IDE при наборе поля.
 *
 * Поэтому единица здесь — не проза, а ТЕГ `@unit` в JSDoc самого поля:
 * `s` (секунды), `ms` (миллисекунды), `progress` (нормализованная доля 0..1,
 * времени не несёт). Тест требует тег у каждого поля со временем И сверяет
 * получившуюся карту с замороженной таблицей: смена единицы у публичного поля
 * становится видимым диффом, а не тихим ×1000 у потребителя.
 *
 * Mutation proof: снять `@unit` у любого поля → RED «поле без тега»; поменять
 * `ms` на `s` → RED «единица разъехалась с замороженной таблицей».
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = join(repoRoot, 'src');

/**
 * Имена полей, которые в этом пакете НЕСУТ ВРЕМЯ. Список намеренно широкий:
 * ложное срабатывание стоит одной строки исключения с причиной, пропуск —
 * молчаливого ×1000 у потребителя.
 */
const TIME_FIELD =
  /^(duration|durationMs|delay|repeatDelay|offset|stagger|gap|at|t|time|timeout|interval|elapsed|startTime|endTime|dt|period|now|totalDuration)$/;

/** Разрешённые значения тега. */
const UNITS = new Set(['s', 'ms', 'progress']);

interface Field {
  readonly path: string;
  readonly line: number;
  readonly owner: string;
  readonly name: string;
  readonly unit: string | undefined;
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      // internal/** не публичен: контракт единиц — обещание ПОТРЕБИТЕЛЮ.
      if (entry !== 'internal') out.push(...tsFiles(p));
    } else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Поля со временем в ЭКСПОРТИРУЕМЫХ типах + их тег @unit (если есть). */
function collectFields(): Field[] {
  const found: Field[] = [];
  for (const file of tsFiles(srcRoot)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    let owner: string | undefined;
    let depth = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const decl = /^export (?:declare )?(?:interface|type) (\w+)/.exec(line);
      if (decl) {
        owner = decl[1];
        depth = 0;
      }
      if (owner !== undefined) {
        depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
        if (depth <= 0 && decl === null) owner = undefined;
      }
      if (owner === undefined) continue;
      const member = /^\s*(?:readonly )?(\w+)\??:\s*(.+?);?\s*$/.exec(line);
      if (member === null) continue;
      const [, name, type] = member as unknown as [string, string, string];
      if (!TIME_FIELD.test(name) || !/\bnumber\b/.test(type)) continue;
      // JSDoc поля — блок непосредственно над строкой.
      let doc = '';
      for (let j = i - 1; j >= 0; j--) {
        const above = lines[j]!;
        if (!/^\s*(\*|\/\*\*)/.test(above)) break;
        doc = `${above}\n${doc}`;
        if (above.includes('/**')) break;
      }
      const tag = /@unit\s+(\w+)/.exec(doc);
      found.push({
        path: relative(repoRoot, file),
        line: i + 1,
        owner,
        name,
        unit: tag?.[1],
      });
    }
  }
  return found.sort((a, b) => `${a.path}:${a.owner}.${a.name}`
    .localeCompare(`${b.path}:${b.owner}.${b.name}`));
}

/**
 * ЗАМОРОЖЕННАЯ карта единиц публичного API (ключ — `Тип.поле`).
 *
 * Не реплика кода, а НЕЗАВИСИМОЕ обещание: тег живёт в src, таблица — здесь.
 * Расхождение означает, что единица поля поменялась, — и это обязано быть
 * намеренным диффом с записью в CHANGELOG, а не побочным эффектом правки.
 */
const FROZEN_UNITS: Record<string, string> = {
  // ─── Фасадный ярус: МИЛЛИСЕКУНДЫ (тайминги уходят прямо в WAAPI/CSS) ─────
  'AnimateOptions.delay': 'ms',
  'AnimateOptions.duration': 'ms',
  'AnimateOptions.now': 'ms',
  'AnimateOptions.stagger': 'ms',
  'CompiledNanoArtifact.delay': 'ms',
  'CompiledNanoArtifact.durationMs': 'ms',
  'CompiledNanoArtifact.stagger': 'ms',
  'CompositorPlan.duration': 'ms',
  'CompositorSpringOptions.delay': 'ms',
  'CompositorSpringOptions.now': 'ms',
  'CompositorStaggerGroupOptions.now': 'ms',
  'CompositorStaggerPlan.duration': 'ms',
  'NanoOptions.duration': 'ms',
  'SpringExecutionPlan.duration': 'ms',
  'StaggerOptions.gap': 'ms',
  'StaticNanoOptions.delay': 'ms',
  'StaticNanoOptions.stagger': 'ms',
  'WaapiCompiled.duration': 'ms',
  'WaapiTiming.delay': 'ms',
  'WaapiTiming.duration': 'ms',

  // ─── Физический ярус: СЕКУНДЫ (одна система единиц с солвером пружины) ───
  'AnimationControls.time': 's',
  'AutoAnimateOptions.duration': 's',
  'BehaviorPoint.t': 's',
  'BlinkOptions.duration': 's',
  'BounceYOptions.duration': 's',
  'BreatheOptions.duration': 's',
  'CompiledPreset.delay': 's',
  'CompiledPreset.duration': 's',
  'CompiledPreset.repeatDelay': 's',
  'DrawOnOptions.duration': 's',
  'DriftOptions.duration': 's',
  'FadeSlideOptions.duration': 's',
  'FromBounceOptions.duration': 's',
  'FromOscillationOptions.period': 's',
  'GesturePoint.t': 's',
  'KeyframesControls.time': 's',
  'KeyframesControls.totalDuration': 's',
  'KeyframesOptions.duration': 's',
  'KeyframesOptions.repeatDelay': 's',
  'PopOptions.duration': 's',
  'PresetControls.time': 's',
  'PresetControls.totalDuration': 's',
  'PresetSpec.delay': 's',
  'PresetSpec.duration': 's',
  'PresetSpec.repeatDelay': 's',
  'PulseOptions.duration': 's',
  'ReadSpringOptions.t': 's',
  'ScrollObserverUpdate.t': 's',
  'ScrollSample.t': 's',
  'ScrubTarget.totalDuration': 's',
  'SegmentConfig.at': 's',
  'SegmentConfig.duration': 's',
  'SegmentConfig.offset': 's',
  'SpinOptions.duration': 's',
  'SugarRunOptions.duration': 's',
  'TimelineControls.time': 's',
  'TimelineControls.totalDuration': 's',
  'WaapiCompileOptions.duration': 's',
  'WaapiCompileOptions.repeatDelay': 's',
  'WiggleOptions.duration': 's',

  // ─── Не время: нормализованная доля [0, 1] ────────────────────────────────
  'WaapiKeyframe.offset': 'progress',
};

describe('контракт единиц времени публичного API', () => {
  it('каждое публичное поле со временем объявляет @unit прямо на поле', () => {
    const naked = collectFields()
      .filter((f) => f.unit === undefined)
      .map((f) => `${f.path}:${f.line} ${f.owner}.${f.name}`);
    // Единица В ШАПКЕ ИНТЕРФЕЙСА не считается: подсказка IDE при наборе поля
    // показывает JSDoc ПОЛЯ, а ошибаются именно в момент набора значения.
    expect(naked, `поля без @unit:\n${naked.join('\n')}`).toEqual([]);
  });

  it('тег принимает только s | ms | progress', () => {
    const bad = collectFields()
      .filter((f) => f.unit !== undefined && !UNITS.has(f.unit))
      .map((f) => `${f.path}:${f.line} ${f.owner}.${f.name} → @unit ${f.unit}`);
    expect(bad).toEqual([]);
  });

  it('карта единиц совпадает с замороженной таблицей', () => {
    const actual: Record<string, string> = {};
    for (const f of collectFields()) actual[`${f.owner}.${f.name}`] = f.unit!;
    expect(actual).toEqual(FROZEN_UNITS);
  });

  it('getting-started перечисляет оба яруса и не обещает единый ярус', () => {
    const page = readFileSync(join(repoRoot, 'docs/getting-started.md'), 'utf8');
    // Прежний текст: «Все длительности и задержки в публичных опциях —
    // МИЛЛИСЕКУНДЫ». Обещание было ложным для восьми субпутей.
    expect(page).not.toMatch(/Все длительности и задержки в публичных опциях/);
    expect(page).toMatch(/МИЛЛИСЕКУНД/);
    expect(page).toMatch(/СЕКУНД/);
    // Обе стороны названы поимённо, чтобы страницу нельзя было «починить»
    // размытой формулировкой.
    for (const subpath of ['./animate', './nano', './timeline', './presets']) {
      expect(page, `ярус ${subpath} не назван`).toContain(subpath);
    }
  });
});
