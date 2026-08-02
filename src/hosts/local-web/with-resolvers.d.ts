/**
 * Ambient declaration for `Promise.withResolvers` (Node >= 20 runtime).
 *
 * tsconfig.node.json targets ES2022, whose standard lib lacks the
 * ES2024.Promise declaration. The shared tsconfig is not owned by the web
 * host task, so this module supplies the identical declaration locally.
 * If the project later bumps the lib to es2024+, the merged interface
 * members are identical and this file becomes a harmless no-op.
 */
declare global {
  interface PromiseConstructor {
    withResolvers<T>(): {
      promise: Promise<T>;
      resolve: (value: T | PromiseLike<T>) => void;
      reject: (reason?: unknown) => void;
    };
  }
}

export {};
