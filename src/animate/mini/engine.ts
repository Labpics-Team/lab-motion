/**
 * animate/mini/engine.ts — движок анимации поверх адаптерного реестра.
 *
 * НЕ ВЕТВИТСЯ по имени свойства: канал резолвит codec через реестр, запись —
 * через adapter.surfaceOf/compose/apply. Новый вид свойства/цели = регистрация
 * в реестре, не правка этого файла (ЗАКОН расширения, registry.ts).
 *
 * Единая семантика времени: и spring, и tween, и все кодеки живут в ОДНОМ
 * прогресс-пространстве p∈[0,1] (readCompositorSpring на from=0,to=1 — та же
 * замкнутая форма, что у compositor-пути пакета). Значение канала =
 * codec.interpolate(from,to)(p). Расширение этого внутреннего слоя не меняет
 * фиксированную публичную поверхность mini.
 *
 * Пути (авто по среде):
 *   reduced — prefers-reduced-motion: reduce → мгновенный снап к финалу без кадров;
 *   main    — rAF-микроцикл в замкнутой форме, фазы кадра update(вычисление)→
 *             render(запись) разведены единым ./frame-шедулером (чтение current-
 *             value сделано ОДИН раз при привязке, per-frame — только запись).
 *
 * ГРАНИЦА ПЕРВОЙ ВЕРСИИ (размерный потолок 5 KB): compositor-offload (WAAPI/
 * Element.animate через compileSpringPlan) в mini НЕ включён — переиспользование
 * компилятора пружина→linear() ядра стоит ~1.75 KB gz и физически не помещается
 * под 5120 (floor compositor+codecs+registry+frame = 5186 БЕЗ движка). Полный
 * compositor-путь живёт в субпути ./animate. mini детектирует reduced-motion и
 * гонит transform/opacity аналитической замкнутой формой на main-потоке.
 *
 * Инварианты: один владелец пары target/поверхность (реестр, supersede при
 * повторном запуске); C¹-подхват value+velocity (dominant-канал); fail-fast
 * (валидация ДО записи — codec.parse); SSR-safe (DOM только в момент вызова);
 * детерминизм (часы только через инжектируемый ./frame requestFrame).
 */

import { MotionParamError } from '../../errors.js';
import { createFrameLoop, frame as defaultFrame, type FrameLoop } from '../../frame/index.js';
import { sampleSpringUnchecked } from '../../internal/read-spring.js';
import { type SpringParams, validateSpringParams } from '../../spring.js';
import type { CodecResolver, PropertyCodec, TargetAdapter } from '../registry.js';
import {
  collectBoundedArrayLike,
  requireAnimateOptions,
  requireAnimateProps,
} from '../targets.js';

const FIXED_DT_MS = (1 / 60) * 1000;
const EASE_DERIV_H = 1e-3;
/** Порог сходимости прогресса (зеркалит CONVERGENCE_THRESHOLD ядра). */
const CONVERGENCE = 1e-3;

/** Дефолты mini (инлайн — НЕ тянем ../tokens): Framer-подобная пружина. */
const DEFAULT_SPRING: SpringParams = { mass: 1, stiffness: 170, damping: 26 };
const DEFAULT_DURATION_MS = 300;
/** Дефолтный tween-ease mini: easeInOutCubic (точную кривую задаёт вызывающий). */
const _defaultEase = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

/** Режим движения (spring/tween взаимоисключающие — гейт в _resolveMode). */
export type MotionMode =
  | { readonly _type: 'spring'; readonly _spring: SpringParams }
  | { readonly _type: 'tween'; readonly _durationMs: number; readonly _ease: (t: number) => number };

/** Значение канала: цель или пара [from, to] (явный from отключает подхват). */
export type PropValue = number | string | readonly [number | string, number | string];

/** Опции движка (публичный контракт mini). */
export interface EngineOptions {
  readonly spring?: SpringParams | undefined;
  readonly duration?: number | undefined;
  readonly ease?: ((t: number) => number) | undefined;
  readonly delay?: number | undefined;
  readonly stagger?: number | undefined;
  readonly onComplete?: (() => void) | undefined;
  /** Шов кадра main-пути (детерминизм тестов). Дефолт: разделяемый ./frame. */
  readonly requestFrame?: ((cb: (ts?: number) => void) => number) | undefined;
  /** Явный ./frame-цикл (переопределяет requestFrame). */
  readonly frame?: FrameLoop | undefined;
  /** Шов reduced-motion. Дефолт: globalThis.matchMedia (если среда умеет). */
  readonly matchMedia?: ((query: string) => { matches: boolean }) | undefined;
}

/** Контролы прогона (агрегированные по целям). */
export interface AnimateControls {
  readonly finished: Promise<void>;
  play(): void;
  pause(): void;
  /** Перемотать к конечному времени (мс); пауза сохраняется, нефинитное игнорируется. */
  seek(tMs: number): void;
  cancel(): void;
  stop(): void;
}

// ─── Реестр состояния по целям (владелец + последнее значение канала) ────────

// Runtime-shape поля ниже приватны всему mini-графу и потому имеют `_`:
// tsup сжимает только такие свойства. Публичные EngineOptions и registry seam
// намеренно остаются без префикса — их имена являются контрактом потребителя.

interface ChannelSnapshot {
  readonly _value: string | number;
  readonly _velocity: number;
}

interface SurfaceOwner {
  _prepare(): void;
  _release(): void;
  _captureChannel(property: string): ChannelSnapshot | undefined;
  _knownChannels(): readonly string[];
  _supersede(replacement?: () => void): void;
}

interface SurfaceRecord {
  _owner: SurfaceOwner | undefined;
  /** Резерв commit закрывает host-reentry до публикации successor. */
  _transition: boolean;
  readonly _last: Map<string, ChannelSnapshot>;
}

const _registry = new WeakMap<object, Map<string, SurfaceRecord>>();

/** Запись поверхности цели (владелец + последнее значение каналов), лениво. */
function _surfaceRecord(target: object, surface: string): SurfaceRecord {
  let map = _registry.get(target);
  if (map === undefined) {
    map = new Map();
    _registry.set(target, map);
  }
  let rec = map.get(surface);
  if (rec === undefined) {
    rec = { _owner: undefined, _transition: false, _last: new Map() };
    map.set(surface, rec);
  }
  return rec;
}

// ─── Разбор опций ─────────────────────────────────────────────────────────────

/** Режим движения из опций: spring ИЛИ tween (взаимоисключающи — fail-fast). */
function _resolveMode(o: EngineOptions): MotionMode {
  const hasSpring = o.spring !== undefined;
  const hasTween = o.duration !== undefined || o.ease !== undefined;
  if (hasSpring && hasTween) {
    throw new MotionParamError('LM136');
  }
  if (hasTween) {
    const durationMs = o.duration ?? DEFAULT_DURATION_MS;
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new MotionParamError('LM137');
    }
    const ease = o.ease ?? _defaultEase;
    if (typeof ease !== 'function') {
      throw new MotionParamError('LM138');
    }
    return { _type: 'tween', _durationMs: durationMs, _ease: ease };
  }
  if (o.spring === undefined) return { _type: 'spring', _spring: DEFAULT_SPRING };
  validateSpringParams(o.spring);
  return {
    _type: 'spring',
    _spring: { ...o.spring },
  };
}

/** Неотрицательное конечное число или дефолт; иначе fail-fast MotionParamError. */
function _nonNeg(v: number | undefined, dflt: number): number {
  const x = v ?? dflt;
  if (!Number.isFinite(x) || x < 0) {
    throw new MotionParamError('LM139');
  }
  return x;
}

/** Активно ли prefers-reduced-motion (guard: нет matchMedia или бросок → false). */
function _prefersReduced(mm: ((q: string) => { matches: boolean }) | undefined): boolean {
  if (typeof mm !== 'function') return false;
  try {
    // Платформенный matchMedia в ряде движков требует Window как receiver;
    // call сохраняет этот контракт без bind-замыкания на каждый animate().
    return mm.call(globalThis, '(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

// ─── Каналы ─────────────────────────────────────────────────────────────────

/** Канал в полёте: кодек + parsed from/to + сериализованное текущее значение. */
interface Channel {
  readonly _property: string;
  readonly _codec: PropertyCodec;
  _interp: (p: number) => unknown;
  /** Числовой диапазон to−from ИЛИ undefined (C⁰-канал). */
  readonly _numRange: number | undefined;
  _value: string | number;
  _velocity: number;
}

/** Спецификация одного свойства (после codec.parse — валидна). */
interface Spec {
  readonly _property: string;
  readonly _codec: PropertyCodec;
  readonly _explicitFrom: unknown | undefined;
  readonly _to: unknown;
}

/** Разбирает props → спеки, резолвя кодек и парся значения (fail-fast ДО записи). */
function _parseSpecs(props: Record<string, PropValue>, registry: CodecResolver): Spec[] {
  const specs: Spec[] = [];
  for (const property of Object.keys(props)) {
    if (property === 'transform') {
      throw new MotionParamError('LM140');
    }
    const codec = registry.resolveCodec(property);
    const raw = props[property]!;
    const pair = Array.isArray(raw) ? (raw as readonly [unknown, unknown]) : undefined;
    if (pair !== undefined && pair.length !== 2) {
      throw new MotionParamError('LM141');
    }
    specs.push({
      _property: property,
      _codec: codec,
      _explicitFrom: pair !== undefined ? codec.parse(pair[0], property) : undefined,
      _to: codec.parse(pair !== undefined ? pair[1] : raw, property),
    });
  }
  return specs;
}

// ─── Подхват скорости (C¹) ────────────────────────────────────────────────────

const _RANGE_EPS = 1e-10;

/** v0 = velocity / range (канон MotionValue); |range|≤eps или non-finite → 0. */
function _normalizeV0(velocity: number, range: number | undefined): number {
  if (range === undefined || !(Math.abs(range) > _RANGE_EPS)) return 0;
  const v0 = velocity / range;
  return Number.isFinite(v0) ? v0 + 0 : 0;
}

/** Привязанная поверхность: каналы + остаточные (замороженные) + v0 группы. */
interface BoundSurface {
  readonly _channels: Channel[];
  readonly _residuals: Map<string, string | number>;
  /** Рабочая композиция переиспользуется между кадрами: render не создаёт Map. */
  readonly _values: Map<string, string | number>;
  readonly _v0: number;
}

/**
 * Привязывает спеки поверхности к цели: резолв from (пара → живой владелец →
 * реестр → adapter.read → codec.parse), сев v0 по доминантному каналу (max
 * |range|), заморозка остаточных transform-каналов (полная transform-строка).
 * НЕ прерывает владельца — supersede делает вызывающий ПОСЛЕ привязки.
 */
function _bindSurface(
  target: object,
  surface: string,
  specs: readonly Spec[],
  adapter: TargetAdapter,
  rec: SurfaceRecord,
): BoundSurface {
  const owner = rec._owner;
  const channels: Channel[] = [];
  let domVel = 0;
  let domRange: number | undefined;

  for (const spec of specs) {
    const codec = spec._codec;
    let from: unknown;
    let velocity = 0;
    if (spec._explicitFrom !== undefined) {
      from = spec._explicitFrom;
    } else {
      const live = owner?._captureChannel(spec._property);
      const stored = rec._last.get(spec._property);
      if (live !== undefined) {
        from = codec.parse(live._value, spec._property);
        velocity = live._velocity;
      } else if (stored !== undefined) {
        from = codec.parse(stored._value, spec._property);
      } else {
        from = codec.parse(adapter.read(target, spec._property), spec._property);
      }
    }
    const numRange = codec.range?.(from, spec._to);
    const interp = codec.interpolate(from, spec._to);
    channels.push({
      _property: spec._property,
      _codec: codec,
      _interp: interp,
      _numRange: numRange,
      _value: codec.serialize(interp(0)),
      _velocity: velocity,
    });
    if (numRange !== undefined && (domRange === undefined || Math.abs(numRange) > Math.abs(domRange))) {
      domRange = numRange;
      domVel = velocity;
    }
  }

  const residuals = new Map<string, string | number>();
  if (surface === 'transform') {
    const animated = new Set(specs.map((s) => s._property));
    const known = new Set<string>(rec._last.keys());
    if (owner !== undefined) for (const k of owner._knownChannels()) known.add(k);
    // scale выигрывает у scaleX/scaleY в _buildTransform: остаточный uniform-scale
    // при анимации ОСЕВОГО канала «съел» бы новый рендер (scaleX не виден). НЕ
    // несём конфликтующий residual 'scale' — тогда осевой канал реально рендерится.
    for (const key of known) {
      if (
        animated.has(key) ||
        (key === 'scale' && (animated.has('scaleX') || animated.has('scaleY')))
      ) {
        continue;
      }
      const snap = owner?._captureChannel(key) ?? rec._last.get(key);
      if (snap !== undefined) residuals.set(key, snap._value);
    }
  }

  const values = new Map(residuals);
  for (const channel of channels) values.set(channel._property, channel._value);
  return {
    _channels: channels,
    _residuals: residuals,
    _values: values,
    _v0: _normalizeV0(domVel, domRange),
  };
}

// ─── Unit: один прогон одной поверхности одной цели ──────────────────────────

interface UnitOptions {
  readonly _target: object;
  readonly _surface: string;
  readonly _adapter: TargetAdapter;
  readonly _record: SurfaceRecord;
  readonly _bound: BoundSurface;
  readonly _mode: MotionMode;
  readonly _delayMs: number;
  readonly _frame: FrameLoop;
  /** reduced-motion: мгновенный снап к финалу без кадров (= _settle сразу). */
  readonly _reduced: boolean;
  readonly _onDone: (natural: boolean) => void;
}

class Unit implements SurfaceOwner {
  private readonly _o: UnitOptions;
  /** До публикации unit инертен тем же состоянием, что после терминала. */
  private _done = true;
  private _prepared = false;
  private _transition = false;
  private _paused = false;
  private _active = false;
  private _gen = 0;
  private _wallMs = 0;
  private _tMs = 0;
  private readonly _v0: number;
  private _lastTs: number | undefined;
  private _converged = false;
  private _off: (() => void) | undefined;
  private _tweenK = 0;
  private _tweenDpdt: number | undefined;

  /** Конструктор намеренно чистый: host-эффекты выполняет prepare/commit. */
  constructor(o: UnitOptions) {
    this._o = o;
    this._v0 = o._bound._v0;
  }

  // ── SurfaceOwner (подхват при повторном animate) ──────────────────────────

  /** Замораживает старого owner на время потенциально враждебного host prepare. */
  _prepare(): void {
    if (this._prepared || this._transition) throw new MotionParamError('LM157');
    this._prepared = true;
  }

  /** Failed successor возвращает старого owner в тот же повторяемый lifecycle. */
  _release(): void {
    this._prepared = false;
  }

  /** Снимок канала для C¹-подхвата: живой канал (value+velocity) или остаток. */
  _captureChannel(property: string): ChannelSnapshot | undefined {
    const ch = this._o._bound._channels.find((c) => c._property === property);
    if (ch !== undefined) {
      // Delay ещё не двигает effect: внутренний seed сохраняется до старта,
      // внешний ретаргет получает фактическую скорость покоя.
      let velocity = this._active ? ch._velocity : 0;
      if (this._active && this._o._mode._type === 'tween') {
        const sampled = (ch._numRange ?? 0) * this._tweenDerivative();
        velocity = Number.isFinite(sampled) ? sampled + 0 : 0;
      }
      return { _value: ch._value, _velocity: velocity };
    }
    const frozen = this._o._bound._residuals.get(property);
    return frozen === undefined ? undefined : { _value: frozen, _velocity: 0 };
  }

  /** Все ключи прогона: живые каналы + остаточные (для residual-проекции). */
  _knownChannels(): readonly string[] {
    return [
      ...this._o._bound._channels.map((c) => c._property),
      ...this._o._bound._residuals.keys(),
    ];
  }

  /** Прерывание прогона повторным animate: стоп без записи, finished (не natural). */
  _supersede(replacement?: () => void): void {
    if (this._done) {
      this._prepared = false;
      return;
    }
    if (this._transition) throw new MotionParamError('LM157');
    this._prepared = false;
    this._transition = true;
    try {
      replacement?.();
    } catch (error) {
      this._transition = false;
      throw error;
    }
    this._finish(false);
  }

  /** Публикация открывает callbacks; reduced пишет только внутри commit. */
  _commit(): void {
    this._done = false;
    if (this._o._reduced) this._settle();
  }

  /** Откат неопубликованного successor без записи и aggregate-report. */
  _rollback(): void {
    this._done = true;
    this._teardown();
  }

  // ── Контролы ──────────────────────────────────────────────────────────────

  /** Пауза: замораживает прогон, уже запланированный кадр становится инертен. */
  pause(): void {
    if (this._done || this._prepared || this._transition || this._paused) return;
    this._paused = true;
    this._teardown(); // постоянные phase-подписки на паузе не держат цикл живым
  }

  /** Возобновление после паузы: сбрасывает ts-базу и планирует новый кадр. */
  play(): void {
    if (this._done || this._prepared || this._transition || !this._paused) return;
    this._paused = false;
    this._lastTs = undefined;
    try {
      this._subscribe();
    } catch (error) {
      this._paused = true;
      throw error;
    }
  }

  /** Перемотка к виртуальному времени tMs: синхронный эмит (вычисление+запись). */
  seek(tMs: number): void {
    // !isFinite отсекает и NaN, и ±Infinity: Infinity утекал бы в _compute/spring
    // (tMs/1000 → ∞ → бросок изнутри). Нефинитная перемотка — no-op, как NaN.
    if (
      this._done ||
      this._prepared ||
      this._transition ||
      !Number.isFinite(tMs)
    ) return;
    this._active = true;
    this._tMs = Math.max(0, tMs);
    this._lastTs = undefined;
    // Немедленный эмит: вычисление + запись синхронно (перемотка видима сразу).
    if (this._compute(this._tMs)) this._settle();
    else this._write();
  }

  /** Отмена: стоп на текущем значении, фиксация в реестр, finished (не natural). */
  cancel(): void {
    if (this._done || this._prepared || this._transition) return;
    this._writeBack();
    this._finish(false);
  }

  // ── main-путь: единый ./frame, фазы update(вычисление)→render(запись) ─────
  //
  // update и render — постоянные подписки lifecycle: в тике сначала фаза
  // update (продвинуть время, посчитать значения каналов, БЕЗ записи в DOM),
  // затем фаза render (записать посчитанное). Так чтение current-value
  // (сделано один раз в _bindSurface) и записи разведены по фазам — layout-
  // thrash исключён. Пустой lifecycle снимает обе подписки и останавливает ./frame.

  /** Одна пара постоянных phase-подписок на весь lifecycle убирает per-frame Entry/closure/off аллокации. */
  _subscribe(): void {
    const gen = this._gen;
    const offU = this._o._frame.update((ts) => {
      try { this._update(ts, gen); } catch { this.cancel(); }
    });
    let offR: () => void;
    try {
      offR = this._o._frame.render(() => {
        try { this._render(gen); } catch { this.cancel(); }
      });
    } catch (error) {
      try { offU(); } catch { /* сохраняем первичную ошибку render-subscribe */ }
      throw error;
    }
    this._off = (): void => {
      try { offU(); } finally { offR(); }
    };
  }

  /** Фаза update: продвинуть время и посчитать значения каналов (без записи). */
  private _update(ts: number | undefined, gen: number): void {
    if (
      gen !== this._gen ||
      this._done ||
      this._prepared ||
      this._transition ||
      this._paused
    ) return;
    let dt: number;
    if (ts === undefined || !Number.isFinite(ts)) {
      dt = FIXED_DT_MS;
      this._lastTs = undefined;
    } else {
      dt = this._lastTs !== undefined ? ts - this._lastTs : 0;
      this._lastTs = ts;
      if (!Number.isFinite(dt)) {
        dt = FIXED_DT_MS;
        this._lastTs = undefined;
      }
    }
    if (dt < 0) dt = 0;
    this._wallMs += dt;
    if (!this._active) {
      if (this._wallMs + FIXED_DT_MS >= this._o._delayMs) {
        this._active = true;
        this._tMs = 0;
      }
    } else {
      this._tMs += dt;
    }
    this._converged = this._active && this._compute(this._tMs);
  }

  /** Фаза render: записать посчитанное; сходимость → точный финал. */
  private _render(gen: number): void {
    if (
      gen !== this._gen ||
      this._done ||
      this._prepared ||
      this._transition ||
      this._paused
    ) return;
    if (this._converged) {
      this._settle();
      return;
    }
    if (this._active) this._write();
  }

  /**
   * Вычисляет (p, dpdt) при виртуальном времени tMs и сэмплит каналы (БЕЗ
   * записи в DOM — она в фазе render). Возвращает true — прогон сошёлся.
   */
  private _compute(tMs: number): boolean {
    const o = this._o;
    let p: number;
    let dpdt: number | undefined;
    if (o._mode._type === 'tween') {
      if (tMs >= o._mode._durationMs) return true;
      const k = tMs / o._mode._durationMs;
      const eased = o._mode._ease(k);
      p = Number.isFinite(eased) ? eased : k;
      this._tweenK = k;
      this._tweenDpdt = undefined;
    } else {
      const r = sampleSpringUnchecked(o._mode._spring, this._v0, tMs / 1000);
      p = r.value;
      dpdt = r.velocity;
      if (Math.abs(p - 1) < CONVERGENCE && Math.abs(dpdt) < CONVERGENCE) return true;
    }
    for (const ch of o._bound._channels) {
      ch._value = ch._codec.serialize(ch._interp(p));
      if (dpdt !== undefined) {
        const vel = ch._numRange !== undefined ? ch._numRange * dpdt : 0;
        ch._velocity = Number.isFinite(vel) ? vel + 0 : 0;
      }
    }
    return false;
  }

  /** Обычный tween-кадр не сэмплирует ease ради скорости; это нужно только ретаргету. */
  private _tweenDerivative(): number {
    if (this._tweenDpdt !== undefined) return this._tweenDpdt;
    const mode = this._o._mode;
    if (mode._type !== 'tween') return 0;
    const k = this._tweenK;
    const k0 = k > EASE_DERIV_H ? k - EASE_DERIV_H : 0;
    const k1 = k + EASE_DERIV_H < 1 ? k + EASE_DERIV_H : 1;
    const raw =
      ((mode._ease(k1) - mode._ease(k0)) * 1000) /
      ((k1 - k0) * mode._durationMs);
    this._tweenDpdt = Number.isFinite(raw) ? raw + 0 : 0;
    return this._tweenDpdt;
  }

  /** Запись поверхности: остаточные + живые каналы → compose → apply в цель. */
  private _write(): void {
    const o = this._o;
    for (const ch of o._bound._channels) o._bound._values.set(ch._property, ch._value);
    o._adapter.apply(
      o._target,
      o._surface,
      o._adapter.compose(o._surface, o._bound._values),
    );
  }

  /** Оседание: точный финал (interp(1)) записан, зафиксирован, finished (natural). */
  private _settle(): void {
    if (this._done) return;
    for (const ch of this._o._bound._channels) {
      ch._value = ch._codec.serialize(ch._interp(1));
      ch._velocity = 0;
    }
    this._write();
    this._writeBack();
    this._finish(true);
  }

  // ── Общее ─────────────────────────────────────────────────────────────────

  /** Снятие подписок кадра и инвалидация поколения (запланированный кадр инертен). */
  private _teardown(): void {
    this._gen++;
    try { this._off?.(); } catch { /* host-off не должен рвать owner transition */ }
    this._off = undefined;
  }

  /** Фиксация последних значений каналов/остатков в реестр (для будущего from). */
  private _writeBack(): void {
    const rec = this._o._record;
    for (const ch of this._o._bound._channels) {
      rec._last.set(ch._property, { _value: ch._value, _velocity: 0 });
    }
    this._o._bound._residuals.forEach((v, k) => {
      if (!rec._last.has(k)) rec._last.set(k, { _value: v, _velocity: 0 });
    });
  }

  /** Терминализация: снимает владение записью, резолвит finished, зовёт onDone. */
  private _finish(natural: boolean): void {
    if (this._done) return;
    this._done = true;
    // Все терминалы сходятся сюда: единый teardown не даёт cancel/supersede
    // дважды инвалидировать поколение и дублировать lifecycle-код.
    this._teardown();
    if (this._o._record._owner === this) this._o._record._owner = undefined;
    this._o._onDone(natural);
  }

}

// ─── Резолв целей (в момент вызова — SSR-safe) ───────────────────────────────

/** Резолв цели(ей) в момент вызова (SSR-safe): селектор → NodeList, список, объект. */
function _resolveTargets(target: unknown, registry: CodecResolver): object[] {
  let source = target;
  if (typeof target === 'string') {
    const doc = (globalThis as { document?: { querySelectorAll?: (s: string) => ArrayLike<object> } }).document;
    const query = doc?.querySelectorAll;
    if (doc === undefined || typeof query !== 'function') {
      throw new MotionParamError('LM149');
    }
    source = query.call(doc, target);
  }
  if (source !== null && typeof source === 'object') {
    // Прямая adapter-цель ПЕРВЫМ: объект с полем length:0 (напр. style-цель)
    // иначе трактуется как пустой список → тихий no-op (цель не анимируется).
    // Валидная прямая цель (resolveAdapter не бросает) — ОДНА цель, не список.
    try {
      registry.resolveAdapter(source);
      return [source];
    } catch (error) {
      // Не маскируем отказ пользовательского matcher-а под array-like fallback.
      if (!(error instanceof MotionParamError)) throw error;
    }
    const snapshot = collectBoundedArrayLike(source);
    for (let i = 0; i < snapshot.length; i++) {
      if (snapshot[i] === null || typeof snapshot[i] !== 'object') {
        throw new MotionParamError('LM147');
      }
    }
    return snapshot as object[];
  }
  throw new MotionParamError('LM146');
}

/** Дефолтный matchMedia-шов: globalThis.matchMedia, если среда его предоставляет. */
// ─── runAnimate: оркестрация целей × поверхностей ────────────────────────────

/**
 * Запускает анимацию props на target через переданный реестр. Вся валидация
 * (режим, delay, stagger, codec.parse, резолв целей) — ДО побочных эффектов:
 * бросок MotionParamError не пишет ни одного стиля (fail-fast).
 */
export function runAnimate(
  registry: CodecResolver,
  target: unknown,
  props: Record<string, PropValue>,
  options: EngineOptions = {},
): AnimateControls {
  // Options валидируются до props/target: оба входа могут содержать getters.
  options = requireAnimateOptions(options);
  const mode = _resolveMode(options);
  const baseDelay = _nonNeg(options.delay, 0);
  const staggerStep = _nonNeg(options.stagger, 0);
  const specs = _parseSpecs(requireAnimateProps(props), registry);
  const targets = _resolveTargets(target, registry);

  const reduced = _prefersReduced(
    options.matchMedia ??
      (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia,
  );
  // Единый ./frame-шедулер: инжектированный requestFrame → выделенный цикл
  // (детерминизм тестов); иначе разделяемый синглтон (один rAF на весь пакет).
  const frameLoop =
    options.frame ??
    (options.requestFrame !== undefined
      ? createFrameLoop({ requestFrame: options.requestFrame })
      : defaultFrame);

  // ── Фаза 1: собрать и провалидировать ВЕСЬ план ДО любой мутации ──────────
  // Резолв адаптера + surfaceOf + _bindSurface (все могут бросить) выполняются
  // для ВСЕХ целей/поверхностей ПЕРЕД supersede/instantiate/write. Иначе бросок
  // на ПОЗДНЕЙ цели оставил бы ранние юниты запущенными (под reduced — с уже
  // записанным финалом): частичная анимация при fail-fast. _bindSurface без
  // побочных эффектов (только read/parse/capture — НЕ прерывает владельца).
  // Кортеж плана [target, surface, adapter, record, bound, delayMs] (без имён
  // полей — экономия байт под потолком mini; порядок = деструктуризация ниже).
  type PlanEntry = readonly [object, string, TargetAdapter, SurfaceRecord, BoundSurface, number];
  const plan: PlanEntry[] = [];
  for (let i = 0; i < targets.length; i++) {
    const tgt = targets[i]!;
    const adapter = registry.resolveAdapter(tgt);
    // Оба операнда конечны, но их сумма/произведение всё ещё могут overflow.
    // Проверяем derived-значение в read-only plan-фазе, до первой подписки.
    const delayMs = _nonNeg(baseDelay + staggerStep * i, 0);

    const bySurface = new Map<string, Spec[]>();
    for (const spec of specs) {
      const surface = adapter.surfaceOf(spec._property);
      const list = bySurface.get(surface);
      if (list === undefined) bySurface.set(surface, [spec]);
      else list.push(spec);
    }

    for (const [surface, list] of bySurface) {
      const rec = _surfaceRecord(tgt, surface);
      const bound = _bindSurface(tgt, surface, list, adapter, rec);
      plan.push([tgt, surface, adapter, rec, bound, delayMs]);
    }
  }

  // Deferred живёт только после полной plan/read-валидации: ошибочный
  // вызов не аллоцирует abandoned Promise и не маскирует MotionParamError.
  const units: Unit[] = [];
  const total = plan.length;
  let done = 0;
  let natural = 0;
  let setupDone = false;
  let resolveFinished!: () => void;
  // Публичный run один, поэтому отдельные Promise каждой поверхности были
  // чистым O(N) мусором: Unit теперь сообщает terminal aggregate-счётчику.
  const maybeComplete = (): void => {
    if (!setupDone || done !== total) return;
    setupDone = false;
    queueMicrotask(resolveFinished);
    if (natural === total) options.onComplete?.();
  };
  const report = (nat: boolean): void => {
    done++;
    if (nat) natural++;
    maybeComplete();
  };

  // ── Фаза 2: transactional commit — только после полной валидации ──────────
  // Host prepare выполняется при замороженном старом owner. До его успешного
  // завершения successor не опубликован, callbacks инертны, а reduced не пишет.
  // Дубликат цели берёт owner прямо из record: второй entry обязан заменить
  // первый локальный unit, а его неудача — сохранить первый повторяемым.
  const localOwners = new Set<SurfaceOwner>();
  let protectedOwner: SurfaceOwner | undefined;
  try {
    for (const [tgt, surface, adapter, rec, bound, delayMs] of plan) {
      const previous = rec._owner;
      const localPrevious = previous !== undefined && localOwners.has(previous);
      if (rec._transition) throw new MotionParamError('LM157');
      rec._transition = true;
      if (previous !== undefined) {
        try {
          previous._prepare();
        } catch (error) {
          rec._transition = false;
          throw error;
        }
      }
      const unit = new Unit({
        _target: tgt,
        _surface: surface,
        _adapter: adapter,
        _record: rec,
        _bound: bound,
        _mode: mode,
        _delayMs: delayMs,
        _frame: frameLoop,
        _reduced: reduced,
        _onDone: report,
      });
      try {
        if (!reduced) unit._subscribe();
        if (reduced) {
          if (previous === undefined) unit._commit();
          else previous._supersede(() => unit._commit());
        } else {
          previous?._supersede();
          rec._owner = unit;
          rec._transition = false;
          unit._commit();
          localOwners.add(unit);
        }
      } catch (error) {
        unit._rollback();
        if (localPrevious) protectedOwner = previous;
        previous?._release();
        rec._transition = false;
        throw error;
      }
      // reduced-снап уже завершён и владельцем не становится. Старый owner
      // очистил запись только ПОСЛЕ успешной replacement-записи.
      if (reduced) rec._transition = false;
      units.push(unit);
    }
  } catch (error) {
    for (let i = units.length - 1; i >= 0; i--) {
      if (units[i] === protectedOwner) continue;
      try { units[i]!.cancel(); } catch { /* продолжаем cleanup соседей */ }
    }
    throw error;
  }
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  setupDone = true;
  maybeComplete();

  const cancel = (): void => units.forEach((u) => u.cancel());
  return {
    finished,
    play: () => units.forEach((u) => u.play()),
    pause: () => units.forEach((u) => u.pause()),
    seek: (tMs) => units.forEach((u) => u.seek(tMs)),
    cancel,
    stop: cancel,
  };
}
