import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeResultFromResponse,
  interceptExpressResponse,
  startedResponse,
  waitForQuickResponse,
} from "../src/responses.js";

/** What Express's res.status(status).json(body) does to a Node res. */
function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const chunk = Buffer.from(JSON.stringify(body));
  res.setHeader("Content-Length", String(chunk.length));
  res.end(chunk, undefined);
}

let server: Server | undefined;

/** Serves one request with `handle`, and returns what the client got. */
async function serveOnce(handle: (res: ServerResponse) => void) {
  server = createServer((_req, res) => handle(res));
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}/`);
  return { status: response.status, body: await response.text() };
}

afterEach(async () => {
  vi.useRealTimers();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(null)));
  server = undefined;
});

describe("startedResponse", () => {
  it("is 202 with status started", async () => {
    const response = startedResponse();

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "started" });
  });
});

describe("waitForQuickResponse", () => {
  it("passes on an answer that comes in time", async () => {
    vi.useFakeTimers();
    const answer = new Promise((resolve) => setTimeout(() => resolve("fast"), 19_999));

    const waiting = waitForQuickResponse(answer, 20_000);
    await vi.advanceTimersByTimeAsync(19_999);

    expect(await waiting).toEqual({ answered: true, response: "fast" });
  });

  it("says when the answer is late", async () => {
    vi.useFakeTimers();

    const waiting = waitForQuickResponse(new Promise(() => {}), 20_000);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(await waiting).toEqual({ answered: false });
  });

  it("rejects when the answer does", async () => {
    const error = new Error("bad input");

    await expect(waitForQuickResponse(Promise.reject(error), 20_000)).rejects.toBe(error);
  });
});

describe("computeResultFromResponse", () => {
  it("makes a 2xx JSON body the result", () => {
    expect(computeResultFromResponse(200, '{"frames":1000}')).toEqual({
      status: "completed",
      result: { frames: 1000 },
    });
  });

  it("fails a 2xx body that isn't JSON", () => {
    expect(computeResultFromResponse(200, "<html>")).toEqual({ status: "failed" });
  });

  it.each([301, 400, 500])("fails a %i, leaving its body out", (status) => {
    expect(computeResultFromResponse(status, '{"stack":"at db.ts:12"}')).toEqual({
      status: "failed",
    });
  });
});

describe("interceptExpressResponse", () => {
  it("lets a quick answer through untouched", async () => {
    let ended: Promise<void> | undefined;

    const client = await serveOnce((res) => {
      ended = interceptExpressResponse(res).ended;
      sendJson(res, 201, { id: 7 });
    });

    expect(client).toEqual({ status: 201, body: '{"id":7}' });
    await expect(ended).resolves.toBeUndefined();
  });

  it("answers started, then captures the work's later answer without throwing", async () => {
    let captured: Promise<unknown> | undefined;
    let workError: unknown;

    const client = await serveOnce((res) => {
      const interception = interceptExpressResponse(res);
      res.setHeader("X-Request", "kept");
      captured = interception.answerStarted();
      try {
        sendJson(res, 200, { frames: 1000, note: "café" });
      } catch (error) {
        workError = error;
      }
    });

    expect(client).toEqual({ status: 202, body: '{"status":"started"}' });
    expect(workError).toBeUndefined();
    expect(await captured).toEqual({
      statusCode: 200,
      body: '{"frames":1000,"note":"café"}',
    });
  });

  it("captures every write, and calls end's callback", async () => {
    let captured: Promise<unknown> | undefined;
    const endCallback = vi.fn();

    await serveOnce((res) => {
      captured = interceptExpressResponse(res).answerStarted();
      res.write('{"a":');
      res.end("1}", endCallback);
    });

    expect(await captured).toEqual({ statusCode: 200, body: '{"a":1}' });
    await vi.waitFor(() => expect(endCallback).toHaveBeenCalledOnce());
  });

  it("keeps a status the work set before 202", async () => {
    let captured: Promise<unknown> | undefined;

    await serveOnce((res) => {
      const interception = interceptExpressResponse(res);
      res.statusCode = 201;
      captured = interception.answerStarted();
      res.removeHeader("Content-Type");
      sendJson(res, res.statusCode, { id: 7 });
    });

    expect(await captured).toEqual({ statusCode: 201, body: '{"id":7}' });
  });

  it("takes the status from writeHead", async () => {
    let captured: Promise<unknown> | undefined;

    await serveOnce((res) => {
      captured = interceptExpressResponse(res).answerStarted();
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("boom");
    });

    expect(await captured).toEqual({ statusCode: 500, body: "boom" });
  });
});
