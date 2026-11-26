// Node's AsyncLocalStorage, as workerd provides it under nodejs_compat: the store core's client
// scope is given in the two-client tests (src/client-scope.ts). Only what is used.
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, callback: () => R): R;
  }
}
