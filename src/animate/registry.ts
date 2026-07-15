/**
 * animate/registry.ts — типовой шов «движок ↔ кодеки/адаптеры».
 *
 * ЗАКОН расширения: новый вид свойства/цели добавляется НОВОЙ реализацией
 * кодека/адаптера за швом CodecResolver, а НЕ ростом центрального switch в
 * движке анимации. Ядро движка (mini/engine.ts) дергает только
 * codec._parse/_interpolate/_serialize и adapter._read/_surfaceOf/_compose/
 * _apply — и НИКОГДА не ветвится по имени свойства.
 *
 * Две абстракции:
 *   PropertyCodec  — как ПАРСИТЬ вход свойства в TParsed, ИНТЕРПОЛИРОВАТЬ пару
 *                    и СЕРИАЛИЗОВАТЬ в CSS-значение.
 *   TargetAdapter  — как ЧИТАТЬ текущее значение свойства цели и как ПИСАТЬ:
 *                    surfaceOf группирует каналы одной записи (transform-
 *                    компоненты → одна transform-строка), compose — ЧИСТАЯ
 *                    композиция каналов поверхности в значение (нужна и
 *                    compositor-кейфрейму, и main-записи), apply — запись в цель.
 *
 * Здесь ЖИВУТ ТОЛЬКО ТИПЫ: единственная production-реализация шва —
 * компилированный O(1)-resolver mini (mini/index.ts) поверх фиксированного
 * набора mini-codecs.ts. Runtime-фабрики реестра в поставке НЕТ намеренно:
 * расширяемый рантайм-реестр был прототипом, недостижимым из публичных
 * entries, и не входит ни в один production-граф.
 *
 * Инварианты реализаций шва: SSR-safe (DOM не трогается на импорте);
 * fail-fast (_resolveCodec/_resolveAdapter на неподдержанном входе бросают
 * MotionParamError ДО любой записи).
 */

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

/** Узкая граница движка: ему нужен только разбор, не мутация набора кодеков. */
export interface CodecResolver {
  /** Кодек для свойства; нет матча → MotionParamError (fail-fast, ДО записи). */
  _resolveCodec(property: string): PropertyCodec;
  /** Адаптер для цели; нет матча → MotionParamError (fail-fast, ДО записи). */
  _resolveAdapter(target: unknown): TargetAdapter;
}
