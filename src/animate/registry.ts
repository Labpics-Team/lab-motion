/**
 * animate/registry.ts — адаптерный реестр целей и кодеков свойств.
 *
 * ЗАКОН расширения: новый вид свойства/цели добавляется РЕГИСТРАЦИЕЙ кодека/
 * адаптера в реестр, а НЕ ростом центрального switch в движке анимации. Ядро
 * движка (mini/engine.ts) дергает только codec._parse/_interpolate/_serialize и
 * adapter._read/_surfaceOf/_compose/_apply — и НИКОГДА не ветвится по имени свойства.
 *
 * Две абстракции (внутренняя граница поставки mini↔full):
 *   PropertyCodec  — как ПАРСИТЬ вход свойства в TParsed, ИНТЕРПОЛИРОВАТЬ пару
 *                    и СЕРИАЛИЗОВАТЬ в CSS-значение.
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
 * fail-fast (_resolveCodec/_resolveAdapter на неподдержанном входе бросают
 * MotionParamError ДО любой записи).
 */

import { MotionParamError } from '../errors.js';

/** Кодек свойства: парс/интерполяция/сериализация одного канала значения. */
export interface PropertyCodec<TParsed = unknown> {
  /** Разбирает вход в TParsed; невалидный вход → MotionParamError (fail-fast). */
  _parse(value: unknown, property: string): TParsed;
  /** Замыкание прогресса p∈[0,1] → TParsed (линейно в пространстве значения). */
  _interpolate(from: TParsed, to: TParsed): (progress: number) => TParsed;
  /** TParsed → CSS-значение (строка/число). */
  _serialize(value: TParsed): string | number;
  /**
   * Числовой диапазон to−from ИЛИ undefined (не-числовой кодек). Даёт движку
   * C¹-подхват в пространстве значения (velocity = range·ṗ); undefined-кодеки
   * подхватываются C⁰ (velocity 0) — канон css-каналов фасада.
   */
  _range?(from: TParsed, to: TParsed): number | undefined;
}

/** Адаптер цели: чтение/запись значений на конкретный вид цели. */
export interface TargetAdapter {
  /** Текущее сериализованное значение свойства цели (для резолва from). */
  _read(target: unknown, property: string): unknown;
  /** Поверхность записи свойства: transform-компоненты → 'transform', иначе само. */
  _surfaceOf(property: string): string;
  /** ЧИСТАЯ композиция сериализованных каналов поверхности в CSS-значение. */
  _compose(surface: string, channels: ReadonlyMap<string, string | number>): string | number;
  /** Применить готовое значение поверхности к цели. */
  _apply(target: unknown, surface: string, value: string | number): void;
}

/** Матчер кодека: предикат по имени свойства + сам кодек. */
interface CodecEntry {
  readonly _match: (property: string) => boolean;
  readonly _codec: PropertyCodec;
}

/** Матчер адаптера: предикат по цели + сам адаптер. */
interface AdapterEntry {
  readonly _match: (target: unknown) => boolean;
  readonly _adapter: TargetAdapter;
}

/** Узкая граница движка: ему нужен только разбор, не мутация реестра. */
export interface CodecResolver {
  /** Кодек для свойства; нет матча → MotionParamError (fail-fast, ДО записи). */
  _resolveCodec(property: string): PropertyCodec;
  /** Адаптер для цели; нет матча → MotionParamError (fail-fast, ДО записи). */
  _resolveAdapter(target: unknown): TargetAdapter;
}

/** Расширяемый реестр full-поставки. */
export interface CodecRegistry extends CodecResolver {
  /** Регистрирует кодек под предикатом свойства (позже — выше приоритет). */
  _registerCodec(match: (property: string) => boolean, codec: PropertyCodec): void;
  /** Регистрирует адаптер под предикатом цели (позже — выше приоритет). */
  _registerAdapter(match: (target: unknown) => boolean, adapter: TargetAdapter): void;
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
    _registerCodec(match, codec): void {
      codecs.push({ _match: match, _codec: codec });
    },
    _registerAdapter(match, adapter): void {
      adapters.push({ _match: match, _adapter: adapter });
    },
    _resolveCodec(property): PropertyCodec {
      for (let i = codecs.length - 1; i >= 0; i--) {
        if (codecs[i]!._match(property)) return codecs[i]!._codec;
      }
      throw new MotionParamError('LM145');
    },
    _resolveAdapter(target): TargetAdapter {
      for (let i = adapters.length - 1; i >= 0; i--) {
        if (adapters[i]!._match(target)) return adapters[i]!._adapter;
      }
      throw new MotionParamError('LM148');
    },
  };
}
