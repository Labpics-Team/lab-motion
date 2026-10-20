/** Один отказ не отменяет остальные принятые действия, включая освобождение siblings. */
export function attemptAll<T>(items: Iterable<T>, apply: (item: T) => void, failures: unknown[] = []): unknown[] {
  for (const item of items) {
    try { apply(item); } catch (error) { failures.push(error); }
  }
  return failures;
}

export function rethrow(failures: readonly unknown[], message: string): void {
  if (failures.length) throw failures.length === 1 ? failures[0] : new AggregateError(failures, message);
}
