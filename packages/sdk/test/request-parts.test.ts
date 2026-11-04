import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import {
  type NodeRequest,
  type NodeResponse,
  readRequestParts,
} from "../src/request-parts.js";

const decoder = new TextDecoder();

async function bodyText(request: Request | NodeRequest): Promise<string> {
  return decoder.decode(await readRequestParts(request).readBody());
}

describe("readRequestParts", () => {
  describe("a Web Request", () => {
    it("reads the method, path and query, and headers", () => {
      const parts = readRequestParts(
        new Request("https://provider.example.com/v1/weather?city=Port+Harcourt", {
          headers: { "X-Varis-Invocation-Id": "var_invk_1" },
        }),
      );

      expect(parts.method).toBe("GET");
      expect(parts.pathAndQuery).toBe("/v1/weather?city=Port+Harcourt");
      expect(parts.header("x-varis-invocation-id")).toBe("var_invk_1");
      expect(parts.header("x-varis-missing")).toBeNull();
    });

    it("reads the body from a clone, leaving it readable", async () => {
      const request = new Request("https://provider.example.com/render", {
        method: "POST",
        body: '{"city":"Lagos"}',
      });

      expect(await bodyText(request)).toBe('{"city":"Lagos"}');
      expect(await request.json()).toEqual({ city: "Lagos" });
    });

    it("refuses a body that was already read", async () => {
      const request = new Request("https://provider.example.com/render", {
        method: "POST",
        body: "{}",
      });
      await request.text();

      await expect(readRequestParts(request).readBody()).rejects.toThrow(
        TypeError,
      );
    });
  });

  describe("a Node req", () => {
    it("reads the method, path and query, and headers", () => {
      const parts = readRequestParts({
        method: "get",
        url: "/weather?city=Lagos",
        headers: { "x-varis-key-id": "k1", "x-forwarded-for": ["a", "b"] },
      });

      expect(parts.method).toBe("GET");
      expect(parts.pathAndQuery).toBe("/weather?city=Lagos");
      expect(parts.header("X-Varis-Key-Id")).toBe("k1");
      expect(parts.header("x-forwarded-for")).toBe("a");
      expect(parts.header("x-varis-missing")).toBeNull();
    });

    it("uses originalUrl inside a mounted Express router", () => {
      // app.use("/v1", router): Express strips /v1 from url, not originalUrl.
      const parts = readRequestParts({
        method: "POST",
        url: "/render?quality=high",
        originalUrl: "/v1/render?quality=high",
        headers: {},
      });

      expect(parts.pathAndQuery).toBe("/v1/render?quality=high");
    });

    it("reads an empty body for GET", async () => {
      expect(await bodyText({ method: "GET", url: "/", headers: {} })).toBe("");
    });

    it("prefers rawBody when a parser keeps it", async () => {
      const raw = new TextEncoder().encode('{ "city" : "Lagos" }');

      expect(
        await bodyText({
          method: "POST",
          headers: {},
          rawBody: raw,
          body: { city: "Lagos" },
        }),
      ).toBe('{ "city" : "Lagos" }');
    });

    it("reads a text body as it is", async () => {
      expect(await bodyText({ method: "POST", headers: {}, body: "plain" })).toBe(
        "plain",
      );
    });

    it.each([
      ["nested objects", '{"a":{"b":{"c":[1,{"d":true}]}},"z":null}'],
      ["arrays", '{"list":[1,"two",[3,[4]],{"five":5}],"empty":[]}'],
      ["Unicode", '{"city":"Ibadan","note":"café 🌍 日本語","rtl":"مرحبا"}'],
      [
        "escaped characters",
        '{"quote":"\\"hi\\"","slash":"a\\\\b","newline":"line\\nbreak","tab":"\\t","control":"\\u0001"}',
      ],
      [
        "large and negative numbers",
        '{"big":9007199254740991,"neg":-42,"float":-0.5,"exp":1e+21,"small":1e-7}',
      ],
      ["empty objects", '{"empty":{},"inner":{"also":{}}}'],
      ["key order", '{"z":1,"a":2,"m":{"y":1,"b":2}}'],
    ])("reproduces a parsed JSON body with %s", async (_label, signed) => {
      // What express.json() does with the gateway's JSON.stringify(input).
      const request = { method: "POST", headers: {}, body: JSON.parse(signed) };

      expect(await bodyText(request)).toBe(signed);
    });

    it("throws a TypeError naming express.json() when no parser ran", async () => {
      const parts = readRequestParts({ method: "POST", headers: {} });

      await expect(parts.readBody()).rejects.toThrow(/express\.json\(\)/);
    });
  });

  it("accepts Node's own req and res types", () => {
    const req = new IncomingMessage(new Socket());
    const res = new ServerResponse(req);
    const nodeRequest: NodeRequest = req;
    const nodeResponse: NodeResponse = res;

    expect(nodeRequest).toBe(req);
    expect(nodeResponse).toBe(res);
  });
});
