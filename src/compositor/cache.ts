/**
 * compositor/cache.ts — ограниченный LRU-кэш execution-артефактов пружин.
 *
 * Зачем: staggered-списки и повторные интеракции компилируют ОДНУ и ту же
 * пружину много раз; компиляция (сетка + RDP) дороже поиска. Кэш амортизирует её
 * по элементам списка.
 *
 * Инвариант hot-path (mandate M1): ПОПАДАНИЕ не аллоцирует. Достигается так:
 * - Оба компилятора передают пять исходных IEEE-754 чисел
 *   (mass/stiffness/damping/v0/tolerance). Полиномиальная свёртка остаётся
 *   числом и не создаёт строк/объектов; окончательную identity проверяют поля.
 * - lookup(a,b,c,d,e) НЕ принимает замыкание-компилятор (замыкание аллоцировало
 *   бы на КАЖДЫЙ вызов, включая попадание); вызывающий сам делает
 *   `lookup → если undefined: compile+store`. Ветка попадания возвращает
 *   существующий артефакт до любой аллокации.
 * - LRU — интрузивный двусвязный список: перенос узла в голову на попадании —
 *   переприсваивание указателей (без new). Вытеснение хвоста на промахе при
 *   заполнении ПЕРЕИСПОЛЬЗУЕТ объект узла (реассайн полей), новый узел
 *   аллоцируется только пока ёмкость не достигнута.
 *
 * Коллизии хеша безопасны: узел хранит пять исходных чисел и сверяет их на
 * попадании (без аллокаций) — несовпадение трактуется как промах (перекомпиляция
 * и перезапись), НИКОГДА не как чужой план. Exact-ключ принципиален: абсолютное
 * квантование малых коэффициентов меняло бы физику сильнее tolerance.
 */

/** Узел интрузивного LRU. Поля мутабельны ради переиспользования при вытеснении. */
interface CacheNode<T> {
  _hash: number;
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  _value: T;
  _prev: CacheNode<T> | null;
  _next: CacheNode<T> | null;
}

/**
 * Свёртка пяти raw double без аллокаций. Коллизия влияет только на hit-rate:
 * lookup всегда сверяет все исходные поля до возврата значения.
 */
function hash5(a: number, b: number, c: number, d: number, e: number): number {
  return ((((a * 31 + b) * 31 + c) * 31 + d) * 31 + e);
}

/** Ёмкость по умолчанию — слотов артефактов кривой в одном кэше. */
export const DEFAULT_CACHE_CAPACITY = 256;

/**
 * Ограниченный LRU числовой exact-key → артефакт кривой. Тип значения задаёт
 * владелец; compositor хранит единый `{ easing, serialized samples }` для всех
 * browser-веток. O(1) поиск/вставка, ноль аллокаций на попадании. Не
 * потокобезопасен (JS однопоточен на кадре).
 */
export class SpringLinearCache<T = string> {
  private readonly _capacity: number;
  private readonly _map = new Map<number, CacheNode<T>>();
  private _head: CacheNode<T> | null = null; // MRU
  private _tail: CacheNode<T> | null = null; // LRU

  constructor(capacity: number = DEFAULT_CACHE_CAPACITY) {
    this._capacity = Number.isInteger(capacity) && capacity > 0 ? capacity : DEFAULT_CACHE_CAPACITY;
  }

  /** Текущее число занятых слотов (диагностика/тесты). */
  get size(): number {
    return this._map.size;
  }

  /** Ёмкость (число слотов). */
  get capacity(): number {
    return this._capacity;
  }

  /**
   * Поиск по точному числовому ключу. Возвращает артефакт при попадании (и двигает
   * узел в голову LRU — без аллокаций) либо undefined при промахе.
   */
  lookup(a: number, b: number, c: number, d: number, e: number): T | undefined {
    const hash = hash5(a, b, c, d, e);
    const node = this._map.get(hash);
    // Сверка исходных чисел отсекает коллизию хеша (промах, не чужой план).
    if (node !== undefined && node.a === a && node.b === b && node.c === c && node.d === d && node.e === e) {
      this._moveToHead(node);
      return node._value;
    }
    return undefined;
  }

  /**
   * Кладёт артефакт под точный числовой ключ. При заполнении вытесняет LRU-хвост,
   * ПЕРЕИСПОЛЬЗУЯ его объект-узел (без аллокации нового). Промах на коллизии
   * хеша перезаписывает старую запись под тем же хешем (её ключ отличался).
   */
  store(a: number, b: number, c: number, d: number, e: number, value: T): void {
    const hash = hash5(a, b, c, d, e);
    const existing = this._map.get(hash);
    if (existing !== undefined) {
      // Тот же хеш: либо повторный store того же ключа, либо коллизия — в обоих
      // случаях перезаписываем узел на месте (реассайн, без аллокации).
      existing.a = a;
      existing.b = b;
      existing.c = c;
      existing.d = d;
      existing.e = e;
      existing._value = value;
      this._moveToHead(existing);
      return;
    }

    let node: CacheNode<T>;
    if (this._map.size >= this._capacity && this._tail !== null) {
      // Вытеснение LRU с переиспользованием узла (ноль аллокаций на устоявшемся
      // потоке промахов при полном кэше).
      node = this._tail;
      this._map.delete(node._hash);
      this._unlink(node);
      node._hash = hash;
      node.a = a;
      node.b = b;
      node.c = c;
      node.d = d;
      node.e = e;
      node._value = value;
    } else {
      node = { _hash: hash, a, b, c, d, e, _value: value, _prev: null, _next: null };
    }
    this._map.set(hash, node);
    this._pushHead(node);
  }

  /** Очистка (тесты/сброс между независимыми прогонами). */
  clear(): void {
    this._map.clear();
    this._head = null;
    this._tail = null;
  }

  // ─── Интрузивный список ────────────────────────────────────────────────────

  private _unlink(node: CacheNode<T>): void {
    const { _prev: prev, _next: next } = node;
    if (prev !== null) prev._next = next;
    else this._head = next;
    if (next !== null) next._prev = prev;
    else this._tail = prev;
    node._prev = null;
    node._next = null;
  }

  private _pushHead(node: CacheNode<T>): void {
    node._prev = null;
    node._next = this._head;
    if (this._head !== null) this._head._prev = node;
    this._head = node;
    if (this._tail === null) this._tail = node;
  }

  private _moveToHead(node: CacheNode<T>): void {
    if (this._head === node) return;
    this._unlink(node);
    this._pushHead(node);
  }
}
