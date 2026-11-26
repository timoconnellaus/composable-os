// Node's AsyncLocalStorage, as workerd provides it under nodejs_compat (packages/db's
// `refreshOnEachCall`, which the runner's object classes use, holds one). Only what is used: no
// Node types here, as apps/app's globals.d.ts declares it.
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, callback: () => R): R;
  }
}
