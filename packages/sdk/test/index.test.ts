import { afterEach, describe, expect, it, vi } from "vitest";
import { Varis } from "../src/index.js";

describe("Varis.services.define", () => {
  it("does nothing at runtime", () => {
    const varis = new Varis();

    const result = varis.services.define<{ city: string }, { temp: number }>({
      slug: "weather",
      name: "Weather",
      description: "Returns the current temperature for any city.",
      service_type: "data",
      categories: ["science"],
      endpoint_url: "https://api.example.com/weather",
      price_cents: 3,
    });

    expect(result).toBeUndefined();
  });
});

describe("Varis.verifyRequest", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls requests.verify and warns once per process", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const request = new Request("https://provider.example.com/weather");
    const varis = new Varis();
    const verify = vi.spyOn(varis.requests, "verify");

    expect(await varis.verifyRequest(request)).toBe(false);
    expect(await new Varis().verifyRequest(request)).toBe(false);

    expect(verify).toHaveBeenCalledWith(request);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toMatch(/varis\.requests\.verify/);
  });
});
