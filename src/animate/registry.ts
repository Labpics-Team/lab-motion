/**
 * animate/registry.ts — адаптерный реестр целей и кодеков свойств.
 *
 * ЗАКОН расширения: новый вид свойства/цели добавляется РЕГИСТРАЦИЕЙ кодека/
 * адаптера в реестр, а НЕ ростом центрального switch в движке анимации. Ядро
 * движка (mini/engine.ts) дергает только codec.parse/interpolate/serialize и
 * adapter.read/surfaceOf/compose/apply — и НИКОГДА не ветвится по имени свойства.
 *
 * Две абстракции (внутренняя граница поставки mini↔full):
 *   PropertyCodec  — как ПАРСИТЬ вход свойства в TParsed, ИНТЕРПОЛИРОВАТЬ пару
 *                    и СЕРИАЛИЗОВАТЬ в CSS-значение; canComposite — можно ли
 *                    свойство отдать compositor-пути (transform/opacity — да).
 *   TargetAdapter  — как ЧИТАТЬ текущее значение свойства цели и как ПИСАТЬ:
 *                    surfaceOf группирует каналы одной записи (transform-
 *                    компоненты → одна transform-строка), compose — ЧИСТАЯ
 *                    композиция каналов поверхности в значение (нужна и
 *                    compositor-кейфрейму, и main-записи), apply — запись в цель.
 *
 * Граница поставки: mini регистрирует МИНИМАЛЬНЫЙ набор (числовой transform/
 * opacity + CSS-переменная + DOM-адаптер); full — расширенный (цвет, SVG-атрибут,
 * plain-object адаптер). mini НЕ импортирует full-набор (граф mini не тянет full).
 *
 * Инварианты: SSR-safe (реестр — чистые данные, DOM не трогается на импорте);
 * fail-fast (resolveCodec/resolveAdapter на неподдержанном входе бросают
 * MotionParamError ДО любой записи).
 */

import { MotionParamError } from '../errors.js';

/** Кодек свойства: парс/интерполяция/сериализация одного канала значения. */
export interface PropertyCodec<TParsed = unknown> {
  /** Разбирает вход в TParsed; невалидный вход → MotionParamError (fail-fast). */
  parse(value: unknown, property: string): TParsed;
  /** Замыкание прогресса p∈[0,1] → TParsed (линейно в пространстве значения). */
  interpolate(from: TParsed, to: TParsed): (progress: number) => TParsed;
  /** TParsed → CSS-значение (строка/число). */
  serialize(value: TParsed): string | number;
  /** Можно ли свойство отдать compositor-пути (transform/opacity — true). */
  canComposite(property: string): boolean;
  /**
   * Числовой диапазон to−from ИЛИ undefined (не-числовой кодек). Даёт движку
   * C¹-подхват в пространстве значения (velocity = range·ṗ); undefined-кодеки
   * подхватываются C⁰ (velocity 0) — канон css-каналов фасада.
   */
  range?(from: TParsed, to: TParsed): number | undefined;
}

/** Адаптер цели: чтение/запись значений на конкретный вид цели. */
export interface TargetAdapter {
  /** Текущее сериализованное значение свойства цели (для резолва from). */
  read(target: unknown, property: string): unknown;
  /** Поверхность записи свойства: transform-компоненты → 'transform', иначе само. */
  surfaceOf(property: string): string;
  /** ЧИСТАЯ композиция сериализованных каналов поверхности в CSS-значение. */
  compose(surface: string, channels: ReadonlyMap<string, string | number>): string | number;
  /** Применить готовое значение поверхности к цели. */
  apply(target: unknown, surface: string, value: string | number): void;
}

/** Матчер кодека: предикат по имени свойства + сам кодек. */
interface CodecEntry {
  readonly match: (property: string) => boolean;
  readonly codec: PropertyCodec;
}

/** Матчер адаптера: предикат по цели + сам адаптер. */
interface AdapterEntry {
  readonly match: (target: unknown) => boolean;
  readonly adapter: TargetAdapter;
}

/** Реестр кодеков/адаптеров. Расширяется register*, читается resolve*. */
export interface CodecRegistry {
  /** Регистрирует кодек под предикатом свойства (позже — выше приоритет). */
  registerCodec(match: (property: string) => boolean, codec: PropertyCodec): void;
  /** Регистрирует адаптер под предикатом цели (позже — выше приоритет). */
  registerAdapter(match: (target: unknown) => boolean, adapter: TargetAdapter): void;
  /** Кодек для свойства; нет матча → MotionParamError (fail-fast, ДО записи). */
  resolveCodec(property: string): PropertyCodec;
  /** Адаптер для цели; нет матча → MotionParamError (fail-fast, ДО записи). */
  resolveAdapter(target: unknown): TargetAdapter;
}

/**
 * Пустой реестр. Кодеки/адаптеры пробуются в порядке ОБРАТНОМ регистрации
 * (позже зарегистрированный перекрывает — full может уточнить mini-дефолт).
 * НИКАКОГО switch — это и есть механизм расширения регистрацией.
 */
export function createRegistry(): CodecRegistry {
  const codecs: CodecEntry[] = [];
  const adapters: AdapterEntry[] = [];

  return {
    registerCodec(match, codec): void {
      codecs.push({ match, codec });
    },
    registerAdapter(match, adapter): void {
      adapters.push({ match, adapter });
    },
    resolveCodec(property): PropertyCodec {
      for (let i = codecs.length - 1; i >= 0; i--) {
        if (codecs[i]!.match(property)) return codecs[i]!.codec;
      }
      throw new MotionParamError(`animate: нет кодека для свойства '${property}'`);
    },
    resolveAdapter(target): TargetAdapter {
      for (let i = adapters.length - 1; i >= 0; i--) {
        if (adapters[i]!.match(target)) return adapters[i]!.adapter;
      }
      throw new MotionParamError(`animate: нет адаптера для цели`);
    },
  };
}
