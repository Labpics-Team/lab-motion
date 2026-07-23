/**
 * compositor/cache.ts — ограниченный LRU-cache артефактов пружин.
 *
 * Зачем: staggered-списки и повторные интеракции компилируют ОДНУ и ту же
 * пружину много раз; компиляция (сетка + RDP) дороже поиска. Кэш амортизирует её
 * по элементам списка.
 *
 * Инвариант hot-path (mandate M1): ПОПАДАНИЕ не аллоцирует. Достигается так:
 * - Оба компилятора передают четыре исходных IEEE-754 числа
 *   (ω²=k/m, c/m, v0, tolerance — scale-инвариантные частные, #239). Полиномиальная свёртка остаётся
 *   числом и не создаёт строк/объектов; окончательную identity проверяют поля.
 * - lookup(a,b,c,d) НЕ принимает замыкание-компилятор (замыкание аллоцировало
 *   бы на КАЖДЫЙ вызов, включая попадание); вызывающий сам делает
 *   `lookup → если undefined: compile+store`. Ветка попадания возвращает
 *   существующий артефакт до любой аллокации.
 * - Recency — интрузивный двусвязный LRU: hit переставляет существующий узел
 *   без аллокации, а полный cold-miss переиспользует хвостовой объект.
 *
 * Коллизии хеша безопасны: узел хранит четыре исходных числа и сверяет их на
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
  _value: T;
  _prev: CacheNode<T> | undefined;
  _next: CacheNode<T> | undefined;
}

/**
 * Свёртка четырёх raw double без аллокаций. Коллизия влияет только на hit-rate:
 * lookup всегда сверяет все исходные поля до возврата значения.
 */
function hash4(a: number, b: number, c: number, d: number): number {
  return (((a * 31 + b) * 31 + c) * 31 + d);
}

/** Ёмкость по умолчанию — слотов артефактов кривой в одном кэше. */
export const DEFAULT_CACHE_CAPACITY = 256;

/**
 * Ограниченный LRU-cache: числовой exact-key → артефакт кривой. Тип задаёт
 * владелец; compositor хранит единый `{ easing, serialized samples }` для всех
 * browser-веток. O(1) и ноль аллокаций на попадании/устоявшемся вытеснении.
 * Не потокобезопасен (JS однопоточен на кадре).
 */
export interface SpringLinearCache<T = string> {
  readonly _capacity: number;
  readonly _map: Map<number, CacheNode<T>>;
  _head: CacheNode<T> | undefined;
  _tail: CacheNode<T> | undefined;
}

export function createSpringLinearCacheState<T = string>(capacity: number): SpringLinearCache<T> {
  // Нормализация живёт на единственной границе создания состояния: ни прямой
  // internal-consumer, ни публичная оболочка не могут собрать безграничный
  // либо неработающий LRU. Дефолт сохраняет прежний публичный контракт.
  const parsed = typeof capacity === 'number' && capacity > 0 && capacity % 1 === 0
    ? capacity
    : DEFAULT_CACHE_CAPACITY;
  return { _capacity: parsed, _map: new Map(), _head: undefined, _tail: undefined };
}

/** Переносит существующий узел в MRU-голову без аллокаций. */
function touch<T>(cache: SpringLinearCache<T>, node: CacheNode<T>): void {
  if (cache._head === node) return;
  const prev = node._prev;
  const next = node._next;
  if (prev) prev._next = next;
  if (next) next._prev = prev;
  else cache._tail = prev;
  node._prev = undefined;
  node._next = cache._head;
  cache._head!._prev = node;
  cache._head = node;
}

/**
 * Поиск по точному числовому ключу. Возвращает артефакт при попадании и даёт
 * узел в MRU-голову либо undefined при промахе.
 */
export function lookupSpringLinearCache<T>(
  cache: SpringLinearCache<T>,
  a: number,
  b: number,
  c: number,
  d: number,
): T | undefined {
  const hash = hash4(a, b, c, d);
  const node = cache._map.get(hash);
  // Сверка исходных чисел отсекает коллизию хеша (промах, не чужой план).
  // Truthiness-гейт эквивалентен !== undefined: в map лежат только узлы-объекты.
  if (node && node.a === a && node.b === b && node.c === c && node.d === d) {
    touch(cache, node);
    return node._value;
  }
  return undefined;
}

/**
 * Кладёт артефакт под точный числовой ключ. При заполнении ПЕРЕИСПОЛЬЗУЕТ
 * LRU-хвост. Промах на коллизии
 * хеша перезаписывает старую запись под тем же хешем (её ключ отличался).
 */
export function storeSpringLinearCache<T>(
  cache: SpringLinearCache<T>,
  a: number,
  b: number,
  c: number,
  d: number,
  value: T,
): void {
  const hash = hash4(a, b, c, d);
  let node = cache._map.get(hash);
  if (node) {
    // Тот же хеш: либо повторный store того же ключа, либо коллизия — в обоих
    // случаях перезаписываем узел на месте (реассайн, без аллокации).
    touch(cache, node);
  } else {
    if (cache._map.size >= cache._capacity) {
      node = cache._tail!;
      cache._map.delete(node._hash);
      touch(cache, node);
      node._hash = hash;
    } else {
      node = {
        _hash: hash,
        a,
        b,
        c,
        d,
        _value: value,
        _prev: undefined,
        _next: cache._head,
      };
      if (cache._head) cache._head._prev = node;
      else cache._tail = node;
      cache._head = node;
    }
    cache._map.set(hash, node);
  }
  // Единая точка реассайна ключа/значения (для свежего literal-узла — повторная
  // запись тех же значений, поведение идентично).
  node.a = a;
  node.b = b;
  node.c = c;
  node.d = d;
  node._value = value;
}

// Холодный inspection/reset shell вынесен из class prototype: consumer-путь
// общей кривой не платит за методы, которые нужны только изолированной фабрике.
export function springLinearCacheSize(cache: SpringLinearCache<unknown>): number {
  return cache._map.size;
}

export function springLinearCacheCapacity(cache: SpringLinearCache<unknown>): number {
  return cache._capacity;
}

export function clearSpringLinearCache(cache: SpringLinearCache<unknown>): void {
  cache._map.clear();
  cache._head = undefined;
  cache._tail = undefined;
}
