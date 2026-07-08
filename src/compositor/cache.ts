/**
 * compositor/cache.ts — ограниченный LRU-кэш linear()-строк пружин.
 *
 * Зачем: staggered-списки и повторные интеракции компилируют ОДНУ и ту же
 * пружину много раз; компиляция (сетка + RDP) дороже поиска. Кэш амортизирует её
 * по элементам списка.
 *
 * Инвариант hot-path (mandate M1): ПОПАДАНИЕ не аллоцирует. Достигается так:
 * - Ключ — пять КВАНТОВАННЫХ целых (mass/stiffness/damping/v0/tolerance),
 *   свёрнутых в один 32-битный числовой хеш (Math.imul-микс). Целые и хеш —
 *   числа, не объекты: их вычисление у вызывающего не аллоцирует.
 * - lookup(a,b,c,d,e) НЕ принимает замыкание-компилятор (замыкание аллоцировало
 *   бы на КАЖДЫЙ вызов, включая попадание); вызывающий сам делает
 *   `lookup → если undefined: compile+store`. Ветка попадания возвращает
 *   существующую строку до любой аллокации.
 * - LRU — интрузивный двусвязный список: перенос узла в голову на попадании —
 *   переприсваивание указателей (без new). Вытеснение хвоста на промахе при
 *   заполнении ПЕРЕИСПОЛЬЗУЕТ объект узла (реассайн полей), новый узел
 *   аллоцируется только пока ёмкость не достигнута.
 *
 * Коллизии хеша безопасны: узел хранит пять квантованных целых и сверяет их на
 * попадании (без аллокаций) — несовпадение трактуется как промах (перекомпиляция
 * и перезапись), НИКОГДА не как чужой план. Квантование — часть контракта:
 * компиляция идёт по ДЕ-квантованным параметрам (шаг мелкий, дельта ≪ tolerance),
 * так что план всегда соответствует своему ключу.
 */

/** Узел интрузивного LRU. Поля мутабельны ради переиспользования при вытеснении. */
interface CacheNode {
  hash: number;
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  value: string;
  prev: CacheNode | null;
  next: CacheNode | null;
}

/** Свёртка пяти целых в 32-битный хеш (Math.imul-микс, без аллокаций). */
function hash5(a: number, b: number, c: number, d: number, e: number): number {
  let h = 0x811c9dc5 | 0;
  h = Math.imul(h ^ (a | 0), 0x01000193);
  h = Math.imul(h ^ (b | 0), 0x01000193);
  h = Math.imul(h ^ (c | 0), 0x01000193);
  h = Math.imul(h ^ (d | 0), 0x01000193);
  h = Math.imul(h ^ (e | 0), 0x01000193);
  return h | 0;
}

/** Ёмкость по умолчанию — слотов linear()-строк в общем кэше. */
export const DEFAULT_CACHE_CAPACITY = 256;

/**
 * Ограниченный LRU квантованный-ключ → linear()-строка. O(1) поиск/вставка,
 * ноль аллокаций на попадании. Не потокобезопасен (JS однопоточен на кадре).
 */
export class SpringLinearCache {
  private readonly _capacity: number;
  private readonly _map = new Map<number, CacheNode>();
  private _head: CacheNode | null = null; // MRU
  private _tail: CacheNode | null = null; // LRU

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
   * Поиск по квантованному ключу. Возвращает строку при попадании (и двигает
   * узел в голову LRU — без аллокаций) либо undefined при промахе.
   */
  lookup(a: number, b: number, c: number, d: number, e: number): string | undefined {
    const hash = hash5(a, b, c, d, e);
    const node = this._map.get(hash);
    // Сверка квантованных полей отсекает коллизию хеша (промах, не чужой план).
    if (node !== undefined && node.a === a && node.b === b && node.c === c && node.d === d && node.e === e) {
      this._moveToHead(node);
      return node.value;
    }
    return undefined;
  }

  /**
   * Кладёт строку под квантованный ключ. При заполнении вытесняет LRU-хвост,
   * ПЕРЕИСПОЛЬЗУЯ его объект-узел (без аллокации нового). Промах на коллизии
   * хеша перезаписывает старую запись под тем же хешем (её ключ отличался).
   */
  store(a: number, b: number, c: number, d: number, e: number, value: string): void {
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
      existing.value = value;
      this._moveToHead(existing);
      return;
    }

    let node: CacheNode;
    if (this._map.size >= this._capacity && this._tail !== null) {
      // Вытеснение LRU с переиспользованием узла (ноль аллокаций на устоявшемся
      // потоке промахов при полном кэше).
      node = this._tail;
      this._map.delete(node.hash);
      this._unlink(node);
      node.hash = hash;
      node.a = a;
      node.b = b;
      node.c = c;
      node.d = d;
      node.e = e;
      node.value = value;
    } else {
      node = { hash, a, b, c, d, e, value, prev: null, next: null };
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

  private _unlink(node: CacheNode): void {
    const { prev, next } = node;
    if (prev !== null) prev.next = next;
    else this._head = next;
    if (next !== null) next.prev = prev;
    else this._tail = prev;
    node.prev = null;
    node.next = null;
  }

  private _pushHead(node: CacheNode): void {
    node.prev = null;
    node.next = this._head;
    if (this._head !== null) this._head.prev = node;
    this._head = node;
    if (this._tail === null) this._tail = node;
  }

  private _moveToHead(node: CacheNode): void {
    if (this._head === node) return;
    this._unlink(node);
    this._pushHead(node);
  }
}
