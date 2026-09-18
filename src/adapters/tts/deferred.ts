/**
 * Promise.withResolvers-style deferred. `Promise.withResolvers` itself needs
 * lib ES2024, which the project's ES2022 target does not provide, so this
 * shared helper keeps the same linear, typed-resolver shape.
 */
export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
