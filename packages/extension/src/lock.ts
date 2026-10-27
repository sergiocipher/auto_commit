/**
 * Returns a function that runs async callbacks one at a time, in call order.
 * Used to make read-modify-write cycles on chrome.storage atomic within the
 * service worker (concurrent messages would otherwise lose updates).
 */
export function createSerialLock(): <T>(fn: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
}
