/**
 * Portable async FIFO queue.
 *
 * Values pushed before a consumer arrives are buffered; values pushed
 * while the consumer is waiting resolve it directly. `close()` terminates
 * the stream. Used for generation event streams and live branch playback.
 */
export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()!({ value: undefined as T, done: true });
    }
  }

    next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.closed) return Promise.resolve({ value: undefined as T, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Number of buffered (not yet consumed) values. */
  pendingCount(): number {
    return this.values.length;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.next() };
  }
}
