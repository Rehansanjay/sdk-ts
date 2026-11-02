import { afterEach, describe, expect, it, vi } from "vitest";
import { keepAliveUntilDone } from "../src/keep-alive.js";

describe("keepAliveUntilDone", () => {
  const NEXT_CONTEXT = Symbol.for("@next/request-context");

  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[NEXT_CONTEXT];
  });

  function nextWaitUntil() {
    const waitUntil = vi.fn();
    (globalThis as Record<symbol, unknown>)[NEXT_CONTEXT] = {
      get: () => ({ waitUntil }),
    };
    return waitUntil;
  }

  it("uses the waitUntil option first", () => {
    const fromNext = nextWaitUntil();
    const option = vi.fn();
    const work = Promise.resolve();

    keepAliveUntilDone(work, option);

    expect(option).toHaveBeenCalledWith(work);
    expect(fromNext).not.toHaveBeenCalled();
  });

  it("uses Next.js's request context next", () => {
    const fromNext = nextWaitUntil();
    const work = Promise.resolve();

    keepAliveUntilDone(work);

    expect(fromNext).toHaveBeenCalledWith(work);
  });

  it("does nothing on a long-running server", () => {
    expect(() => keepAliveUntilDone(Promise.resolve())).not.toThrow();
  });

  it("ignores a platform that refuses", () => {
    expect(() =>
      keepAliveUntilDone(Promise.resolve(), () => {
        throw new Error("outside a request");
      })
    ).not.toThrow();
  });
});
