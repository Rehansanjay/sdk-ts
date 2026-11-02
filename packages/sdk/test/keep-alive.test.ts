import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cloudflare = vi.hoisted(() => ({
  waitUntil: undefined as ((promise: Promise<unknown>) => void) | undefined,
  loads: 0,
}));

/** The faked "cloudflare:workers", counting how often it's loaded. */
function cloudflareModule() {
  cloudflare.loads += 1;
  return { waitUntil: cloudflare.waitUntil };
}

vi.mock("cloudflare:workers", () => cloudflareModule());

const NEXT = Symbol.for("@next/request-context");
const VERCEL = Symbol.for("@vercel/request-context");
const NETLIFY = Symbol.for("@netlify/functions/request-context-store");
const globals = globalThis as Record<symbol, unknown>;

/** A fresh copy of the module, so its Cloudflare cache starts empty. */
async function loadKeepAlive() {
  vi.resetModules();
  return await import("../src/keep-alive.js");
}

/** Fakes a request context with `get()`, as Next.js and Vercel keep it. */
function fakeRequestContext(symbol: symbol) {
  const waitUntil = vi.fn();
  globals[symbol] = { get: () => ({ waitUntil }) };
  return waitUntil;
}

/** Fakes Netlify's AsyncLocalStorage of the request's context. */
function fakeNetlifyStore() {
  const waitUntil = vi.fn();
  globals[NETLIFY] = { getStore: () => ({ context: { waitUntil } }) };
  return waitUntil;
}

function onCloudflareWorkers() {
  vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
}

beforeEach(() => {
  cloudflare.waitUntil = vi.fn();
  cloudflare.loads = 0;
});

afterEach(() => {
  delete globals[NEXT];
  delete globals[VERCEL];
  delete globals[NETLIFY];
  vi.unstubAllGlobals();
  vi.doMock("cloudflare:workers", () => cloudflareModule());
});

describe("keepAliveUntilDone", () => {
  /** Every platform at once, plus the option. */
  async function everyPlatform() {
    onCloudflareWorkers();
    const keepAlive = await loadKeepAlive();
    await keepAlive.loadCloudflareWaitUntil();
    return {
      keepAlive,
      option: vi.fn(),
      next: fakeRequestContext(NEXT),
      vercel: fakeRequestContext(VERCEL),
      netlify: fakeNetlifyStore(),
      cloudflare: cloudflare.waitUntil as ReturnType<typeof vi.fn>,
    };
  }

  it("uses the waitUntil option first", async () => {
    const { keepAlive, option, next } = await everyPlatform();
    const work = Promise.resolve();

    keepAlive.keepAliveUntilDone(work, option);

    expect(option).toHaveBeenCalledWith(work);
    expect(next).not.toHaveBeenCalled();
  });

  it("then Next.js, Vercel, Netlify, and Cloudflare, in that order", async () => {
    const hooks = await everyPlatform();
    const order: Array<[symbol | null, ReturnType<typeof vi.fn>]> = [
      [NEXT, hooks.next],
      [VERCEL, hooks.vercel],
      [NETLIFY, hooks.netlify],
      [null, hooks.cloudflare],
    ];

    for (const [symbol, hook] of order) {
      const work = Promise.resolve();
      hooks.keepAlive.keepAliveUntilDone(work);

      expect(hook).toHaveBeenCalledExactlyOnceWith(work);
      for (const [, other] of order) {
        if (other !== hook) expect(other).not.toHaveBeenCalled();
      }
      hook.mockClear();
      if (symbol) delete globals[symbol];
    }
  });

  it("does nothing on a long-running server", async () => {
    const keepAlive = await loadKeepAlive();

    expect(() => keepAlive.keepAliveUntilDone(Promise.resolve())).not.toThrow();
  });

  it("ignores a platform that refuses", async () => {
    const keepAlive = await loadKeepAlive();

    expect(() =>
      keepAlive.keepAliveUntilDone(Promise.resolve(), () => {
        throw new Error("outside a request");
      })
    ).not.toThrow();
  });
});

describe("the platform readers", () => {
  it("reads Vercel's request context, as @vercel/functions does", async () => {
    const waitUntil = fakeRequestContext(VERCEL);
    const { readVercelWaitUntil } = await loadKeepAlive();
    const work = Promise.resolve();

    readVercelWaitUntil()!(work);

    expect(waitUntil).toHaveBeenCalledWith(work);
  });

  it("reads Netlify's context store, calling waitUntil on its context", async () => {
    const context = { waitUntil: vi.fn() };
    globals[NETLIFY] = { getStore: () => ({ context }) };
    const { readNetlifyWaitUntil } = await loadKeepAlive();

    readNetlifyWaitUntil()!(Promise.resolve());

    expect(context.waitUntil.mock.contexts[0]).toBe(context);
  });

  it.each([
    ["Next.js", NEXT, "readNextWaitUntil"],
    ["Vercel", VERCEL, "readVercelWaitUntil"],
    ["Netlify", NETLIFY, "readNetlifyWaitUntil"],
  ] as const)("returns undefined for %s outside a request, or broken", async (_name, symbol, reader) => {
    const keepAlive = await loadKeepAlive();

    expect(keepAlive[reader]()).toBeUndefined();
    globals[symbol] = { get: () => undefined, getStore: () => undefined };
    expect(keepAlive[reader]()).toBeUndefined();
    globals[symbol] = {
      get: () => {
        throw new Error("no store");
      },
      getStore: () => {
        throw new Error("no store");
      },
    };
    expect(keepAlive[reader]()).toBeUndefined();
    globals[symbol] = { get: () => ({ waitUntil: "no" }), getStore: () => ({ context: {} }) };
    expect(keepAlive[reader]()).toBeUndefined();
  });

  it("imports Cloudflare's waitUntil once on Workers", async () => {
    onCloudflareWorkers();
    const keepAlive = await loadKeepAlive();
    const work = Promise.resolve();

    expect(keepAlive.readCloudflareWaitUntil()).toBeUndefined();
    await Promise.all([
      keepAlive.loadCloudflareWaitUntil(),
      keepAlive.loadCloudflareWaitUntil(),
    ]);
    keepAlive.readCloudflareWaitUntil()!(work);

    expect(cloudflare.waitUntil).toHaveBeenCalledWith(work);
    expect(cloudflare.loads).toBe(1);
  });

  it("doesn't try the Cloudflare import anywhere else", async () => {
    const keepAlive = await loadKeepAlive();

    await keepAlive.loadCloudflareWaitUntil();

    expect(cloudflare.loads).toBe(0);
    expect(keepAlive.readCloudflareWaitUntil()).toBeUndefined();
  });

  it("has no Cloudflare hook when the import fails, and doesn't throw", async () => {
    onCloudflareWorkers();
    vi.doMock("cloudflare:workers", () => {
      throw new Error("No such module");
    });
    const keepAlive = await loadKeepAlive();

    await expect(keepAlive.loadCloudflareWaitUntil()).resolves.toBeUndefined();
    expect(keepAlive.readCloudflareWaitUntil()).toBeUndefined();
  });
});

describe("build safety", () => {
  it("has no cloudflare:workers literal for a bundler to resolve", () => {
    const source = readFileSync(new URL("../src/keep-alive.ts", import.meta.url), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

    expect(code).not.toMatch(/cloudflare:workers/);
    expect(source).toMatch(/import\(\/\* webpackIgnore: true \*\/ \/\* @vite-ignore \*\/ specifier\)/);
  });

  it("never loads cloudflare:workers when Node imports and uses the package", async () => {
    vi.resetModules();
    const { Varis } = await import("../src/index.js");

    await new Varis().requests.verify(new Request("https://provider.example.com/render"));

    expect(cloudflare.loads).toBe(0);
  });
});
