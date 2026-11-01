import { afterEach, describe, expect, it, vi } from "vitest";
import { Varis } from "../src/index.js";
import { rememberVerification } from "../src/requests.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rememberVerification", () => {
  it("creates one record per request and returns it after", () => {
    const records = new WeakMap<object, object>();
    const request = new Request("https://provider.example.com/render");

    const first = rememberVerification(records, request);

    expect(rememberVerification(records, request)).toBe(first);
    expect(rememberVerification(records, new Request(request))).not.toBe(first);
  });
});

describe("requests.verify", () => {
  it("verifies each request once", async () => {
    const varis = new Varis({ publicKeys: [] });
    const request = new Request("https://provider.example.com/render", {
      headers: {
        "x-varis-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-varis-signature": btoa("x".repeat(64)),
      },
    });
    const readBody = vi.spyOn(request, "clone");

    expect(await varis.requests.verify(request)).toBe(false);
    expect(await varis.requests.verify(request)).toBe(false);

    expect(readBody).toHaveBeenCalledOnce();
  });
});
