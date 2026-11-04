/**
 * keep-alive.ts: asks a serverless platform to keep running until a long
 * call's result is sent to Varis, after the route has answered.
 *
 * PLATFORMS
 * Each platform keeps the current request's `waitUntil` where the SDK can
 * read it without the platform's package. Each reader returns undefined,
 * never throws.
 * - Next.js, on any host:
 *   `globalThis[Symbol.for("@next/request-context")].get().waitUntil`,
 *   documented with `after` in
 *   node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md.
 * - Vercel, any framework:
 *   `globalThis[Symbol.for("@vercel/request-context")].get().waitUntil`, as
 *   @vercel/functions 3.10.5 reads it (get-context.js and wait-until.js).
 * - Netlify Functions:
 *   `globalThis[Symbol.for("@netlify/functions/request-context-store")]`,
 *   an AsyncLocalStorage, as `.getStore().context.waitUntil`, which is what
 *   @netlify/functions 6.0.3's getContext() reads (dist/main.js, from
 *   src/lib/context_store.ts). The symbol is internal to that package:
 *   re-check it whenever Netlify changes @netlify/functions.
 * - Cloudflare Workers: `waitUntil` from "cloudflare:workers", callable
 *   anywhere in a request without `ctx` (Cloudflare changelog, 2025-08-08).
 *   Loaded only on Workers, by a dynamic import that bundlers don't follow,
 *   so a Next.js or Vite build of a Node provider never tries to resolve
 *   it. `verify`, which every route awaits, starts the import, so it has
 *   finished by the time the SDK answers 202.
 */

export type WaitUntil = (promise: Promise<unknown>) => void;

/**
 * "cloudflare:workers", built at runtime so no bundler finds the literal
 * and tries to resolve it.
 */
const CLOUDFLARE_WORKERS_MODULE = ["cloudflare", "workers"].join(":");

/** Set once `loadCloudflareWaitUntil` has imported it, on Workers only. */
let cloudflareWaitUntil: WaitUntil | undefined;
let cloudflareLoad: Promise<void> | undefined;

/**
 * Asks the platform to keep running until `promise` settles: the
 * `waitUntil` option first, then Next.js, Vercel, Netlify, and Cloudflare
 * Workers. On a long-running server there's nothing to ask, and the promise
 * runs anyway.
 */
export function keepAliveUntilDone(
  promise: Promise<unknown>,
  waitUntil?: WaitUntil,
): void {
  const hook = waitUntil ??
    readNextWaitUntil() ??
    readVercelWaitUntil() ??
    readNetlifyWaitUntil() ??
    readCloudflareWaitUntil();
  try {
    hook?.(promise);
  } catch {
    // Outside a request, the platform may refuse. The promise still runs.
  }
}

export function readNextWaitUntil(): WaitUntil | undefined {
  return readFromRequestContext("@next/request-context");
}

export function readVercelWaitUntil(): WaitUntil | undefined {
  return readFromRequestContext("@vercel/request-context");
}

export function readNetlifyWaitUntil(): WaitUntil | undefined {
  try {
    const store = readGlobal("@netlify/functions/request-context-store") as
      | { getStore?(): { context?: { waitUntil?: unknown } } | undefined }
      | undefined;
    return bindWaitUntil(store?.getStore?.()?.context);
  } catch {
    return undefined;
  }
}

/** Cloudflare's `waitUntil`, once `loadCloudflareWaitUntil` has finished. */
export function readCloudflareWaitUntil(): WaitUntil | undefined {
  return cloudflareWaitUntil;
}

/**
 * Starts importing Cloudflare's `waitUntil`, once, on Workers only.
 * Resolves when it's done, and never rejects: without the module there's
 * just no Cloudflare hook.
 */
export function loadCloudflareWaitUntil(): Promise<void> {
  if (!isCloudflareWorkers()) return Promise.resolve();
  cloudflareLoad ??= Promise.resolve()
    .then(() => importIgnoredByBundlers(CLOUDFLARE_WORKERS_MODULE))
    .then((module) => {
      cloudflareWaitUntil = bindWaitUntil(module as { waitUntil?: unknown });
    })
    .catch(() => {});
  return cloudflareLoad;
}

function isCloudflareWorkers(): boolean {
  try {
    return globalThis.navigator?.userAgent === "Cloudflare-Workers";
  } catch {
    return false;
  }
}

/** A dynamic import that webpack, Turbopack, and Vite leave alone. */
function importIgnoredByBundlers(specifier: string): Promise<unknown> {
  return import(/* webpackIgnore: true */ /* @vite-ignore */ specifier);
}

/** `waitUntil` from a request context with `get()`, as Next.js and Vercel keep it. */
function readFromRequestContext(name: string): WaitUntil | undefined {
  try {
    const context = readGlobal(name) as
      | { get?(): { waitUntil?: unknown } | undefined }
      | undefined;
    return bindWaitUntil(context?.get?.());
  } catch {
    return undefined;
  }
}

/** What a platform keeps on `globalThis` under `Symbol.for(name)`. */
function readGlobal(name: string): unknown {
  return (globalThis as Record<symbol, unknown>)[Symbol.for(name)];
}

/** The owner's `waitUntil`, called as its method, or undefined. */
function bindWaitUntil(
  owner: { waitUntil?: unknown } | undefined,
): WaitUntil | undefined {
  const waitUntil = owner?.waitUntil;
  if (typeof waitUntil !== "function") return undefined;
  return (promise) => waitUntil.call(owner, promise);
}
