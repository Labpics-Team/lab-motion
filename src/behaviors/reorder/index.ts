/**
 * Управляемая перестановка: приложение владеет порядком, resolver — только
 * снимком геометрии и текущим намерением. Никаких DOM, физики или часов.
 * Опциональный subpath не импортируется другими behaviors/animation entries.
 */
import type { FlipRect } from '../../flip/index.js';

export type ReorderKey = string | number;
export type ReorderAxis = 'x' | 'y' | 'both';
export type ReorderStep = 'previous' | 'next' | 'first' | 'last' | 'left' | 'right' | 'up' | 'down';

/** Порядок элементов — подтверждённый порядок приложения. Нет rect → не измерен. */
export interface ReorderItem<K extends ReorderKey> {
  readonly key: K;
  readonly rect?: FlipRect | undefined;
}

/** Immutable предложение, действительное только до следующего изменения intent/snapshot. */
export interface ReorderProposal<K extends ReorderKey> {
  readonly key: K;
  readonly over: K;
  readonly from: number;
  readonly to: number;
}

export interface ReorderOptions<K extends ReorderKey> {
  readonly items: readonly ReorderItem<K>[];
  readonly axis?: ReorderAxis | 'auto' | undefined;
  readonly direction?: 'ltr' | 'rtl' | undefined;
  /** Callback не является commit. После принятия вызвать update с реальной geometry. */
  readonly onReorder: (keys: readonly K[], proposal: ReorderProposal<K>) => void;
}

export interface ReorderSession {
  readonly active: boolean;
  /** Желаемый центр переносимого элемента, в той же системе координат, что rect. */
  move(center: { readonly x: number; readonly y: number }): void;
  /** Logical previous/next либо физическое направление стрелки. */
  step(direction: ReorderStep): void;
  /** Завершить ввод. Уже подтверждённый приложением порядок не откатывается. */
  end(): void;
  cancel(): void;
}

export interface ReorderController<K extends ReorderKey> {
  readonly activeKey: K | undefined;
  readonly axis: ReorderAxis;
  update(items: readonly ReorderItem<K>[]): void;
  start(key: K): ReorderSession | undefined;
  /** Проверка delayed/async proposal перед commit, не разрешение изменить данные. */
  isCurrent(proposal: ReorderProposal<K>): boolean;
  cancel(): void;
  destroy(): void;
}

interface Slot<K> { _key: K; _x: number; _y: number }
interface Layout<K> { _slots: Slot<K>[]; _indices: Map<K, number>; _axis: ReorderAxis }

// Числовой envelope geometry, не физические параметры. Вычитания и hypot
// представимы без overflow; дробные CSS-координаты внутри диапазона разрешены.
function coordinate(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new RangeError('reorder: coordinate must be finite and within MAX_SAFE_INTEGER');
  }
  return value;
}

function snapshot<K extends ReorderKey>(items: readonly ReorderItem<K>[]): Layout<K> {
  if (!Array.isArray(items)) throw new TypeError('reorder: items must be an array');
  const length = items.length;
  if (!Number.isInteger(length) || length < 0 || length > 100_000) throw new RangeError('reorder: at most 100000 items');
  const slots: Slot<K>[] = [];
  const indices = new Map<K, number>();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < length; i++) {
    if (!Object.hasOwn(items, i)) throw new TypeError('reorder: sparse items');
    const item: ReorderItem<K> | undefined = items[i];
    const key = item?.key;
    if (!(typeof key === 'string' || typeof key === 'number' && Number.isFinite(key)) || indices.has(key)) {
      throw new TypeError('reorder: keys must be unique strings or finite numbers');
    }
    const rect = item!.rect;
    let x = NaN, y = NaN;
    if (rect !== undefined) {
      const left = coordinate(rect.x), top = coordinate(rect.y);
      const width = coordinate(rect.width), height = coordinate(rect.height);
      if (width < 0 || height < 0) throw new RangeError('reorder: negative rectangle size');
      if (width > 0 && height > 0) {
        x = coordinate(left + width / 2); y = coordinate(top + height / 2);
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
    indices.set(key, i); slots.push({ _key: key, _x: x, _y: y });
  }
  return { _slots: slots, _indices: indices, _axis: minY === maxY ? 'x' : minX === maxX ? 'y' : 'both' };
}

class Session<K extends ReorderKey> implements ReorderSession {
  constructor(public _owner: Owner<K> | undefined, readonly _key: K) {}
  get active(): boolean { return this._owner !== undefined; }
  move(center: { readonly x: number; readonly y: number }): void { this._owner?._move(this, center); }
  step(direction: ReorderStep): void { this._owner?._step(this, direction); }
  end(): void { this._owner?.cancel(); }
  cancel(): void { this.end(); }
}

class Owner<K extends ReorderKey> implements ReorderController<K> {
  private _session: Session<K> | undefined;
  private _proposal: ReorderProposal<K> | undefined;
  constructor(
    private _layout: Layout<K> | undefined,
    private readonly _axis: ReorderAxis | 'auto',
    private readonly _direction: 'ltr' | 'rtl',
    private _onReorder: ReorderOptions<K>['onReorder'] | undefined,
  ) {}

  get activeKey(): K | undefined { return this._session?._key; }
  get axis(): ReorderAxis { return this._axis === 'auto' ? this._layout?._axis ?? 'both' : this._axis; }

  update(items: readonly ReorderItem<K>[]): void {
    const before = this._layout;
    if (!before) return;
    const next = snapshot(items);
    // Только успешный вложенный commit отзывает внешний input. Failed input
    // не меняет identity снимка; destroy тоже не даёт воскресить owner.
    if (this._layout !== before) return;
    this._layout = next; this._proposal = undefined;
    const session = this._session;
    if (session) {
      const index = next._indices.get(session._key);
      if (index === undefined || Number.isNaN(next._slots[index]!._x)) this.cancel();
    }
  }

  start(key: K): ReorderSession | undefined {
    const layout = this._layout;
    const index = layout?._indices.get(key);
    if (index === undefined || Number.isNaN(layout!._slots[index]!._x)) return undefined;
    this.cancel();
    return this._session = new Session(this, key);
  }

  isCurrent(proposal: ReorderProposal<K>): boolean {
    return this._proposal !== undefined && this._proposal === proposal;
  }

  cancel(): void {
    if (this._session) this._session._owner = undefined;
    this._session = undefined; this._proposal = undefined;
  }

  destroy(): void { this.cancel(); this._layout = undefined; this._onReorder = undefined; }

  _move(session: Session<K>, center: { readonly x: number; readonly y: number }): void {
    const layout = this._layout!;
    const x = coordinate(center.x), y = coordinate(center.y);
    if (session._owner !== this || this._layout !== layout) return;
    const from = layout._indices.get(session._key)!;
    const axis = this.axis;
    // Собственный slot участвует в поиске и выигрывает равные расстояния:
    // граница между ячейками не вызывает дрожание или ложный reorder.
    let to = from, best = Infinity;
    for (let i = 0; i < layout._slots.length; i++) {
      const slot = layout._slots[i]!;
      const d = Math.hypot(axis === 'y' ? 0 : x - slot._x, axis === 'x' ? 0 : y - slot._y);
      if (d < best || d === best && i === from) { best = d; to = i; }
    }
    this._propose(session, from, to);
  }

  _step(session: Session<K>, direction: ReorderStep): void {
    const layout = this._layout!;
    const from = layout._indices.get(session._key)!;
    let to = from;
    const axis = this.axis;
    switch (direction) {
      case 'previous': to--; break;
      case 'next': to++; break;
      case 'first': to = 0; break;
      case 'last': to = layout._slots.length - 1; break;
      case 'left': case 'right': case 'up': case 'down': {
        const horizontal = direction === 'left' || direction === 'right';
        const sign = direction === 'left' || direction === 'up' ? -1 : 1;
        if (axis === 'x' && horizontal) to += sign * (this._direction === 'rtl' ? -1 : 1);
        else if (axis === 'y' && !horizontal) to += sign;
        else if (axis === 'both') {
          const start = layout._slots[from]!;
          let best = Infinity;
          for (let i = 0; i < layout._slots.length; i++) {
            const slot = layout._slots[i]!;
            const dx = slot._x - start._x, dy = slot._y - start._y;
            const forward = (horizontal ? dx : dy) * sign;
            const d = Math.hypot(dx, dy);
            if (forward > 0 && d < best) { best = d; to = i; }
          }
        }
        break;
      }
      default: throw new TypeError('reorder: unknown keyboard direction');
    }
    if (to === from || to < 0 || to >= layout._slots.length || Number.isNaN(layout._slots[to]!._x)) return;
    this._propose(session, from, to);
  }

  private _propose(session: Session<K>, from: number, to: number): void {
    if (to === from) { this._proposal = undefined; return; }
    if (this._proposal?.to === to) return;
    const slots = this._layout!._slots;
    // Одна вставка для pointer и keyboard. До изменения intent нет ни
    // permutation array, ни callback: неизменный pointer input стоит только scan.
    const keys = slots.map(slot => slot._key);
    keys.splice(from, 1); keys.splice(to, 0, session._key);
    const proposal: ReorderProposal<K> = Object.freeze({ key: session._key, over: slots[to]!._key, from, to });
    this._proposal = proposal;
    try { this._onReorder!(Object.freeze(keys), proposal); } catch (error) {
      if (session._owner === this) this.cancel();
      throw error;
    }
  }
}

/**
 * Создать resolver над принадлежащим приложению порядком. Структурно неверные
 * inputs дают TypeError, geometry/cardinality вне envelope — RangeError.
 * Исходные getter/callback exceptions не оборачиваются. Импорт SSR-safe.
 */
export function createReorder<K extends ReorderKey>(options: ReorderOptions<K>): ReorderController<K> {
  const axis = options.axis ?? 'auto', direction = options.direction ?? 'ltr', onReorder = options.onReorder;
  if (!['auto', 'x', 'y', 'both'].includes(axis) || !['ltr', 'rtl'].includes(direction) || typeof onReorder !== 'function') {
    throw new TypeError('reorder: invalid axis, direction or onReorder');
  }
  return new Owner(snapshot(options.items), axis, direction, onReorder);
}
