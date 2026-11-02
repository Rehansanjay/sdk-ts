/**
 * keep-alive.ts: asks a serverless platform to keep running until a long
 * call's result is sent to Varis, after the route has answered.
 */

export type WaitUntil = (promise: Promise<unknown>) => void;

/**
 * Asks the platform to keep running until `promise` settles: the
 * `waitUntil` option first, then Next.js's request context. On a
 * long-running server there's nothing to ask, and the promise runs anyway.
 */
export function keepAliveUntilDone(
  promise: Promise<unknown>,
  waitUntil?: WaitUntil,
): void {
  const hook = waitUntil ?? readNextWaitUntil();
  try {
    hook?.(promise);
  } catch {
    // Outside a request, the platform may refuse. The promise still runs.
  }
}

/**
 * Next.js's `waitUntil` for the current request, documented with `after`
 * in node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md.
 */
function readNextWaitUntil(): WaitUntil | undefined {
  const context = (globalThis as Record<symbol, unknown>)[
    Symbol.for("@next/request-context")
  ] as { get?(): { waitUntil?: WaitUntil } | undefined } | undefined;
  const store = context?.get?.();
  return store?.waitUntil ? (promise) => store.waitUntil!(promise) : undefined;
}
