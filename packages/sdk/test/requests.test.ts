import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type NodeRequest,
  type NodeResponse,
  Varis,
  type VarisNotificationDetails,
  type VarisPublicKey,
} from "../src/index.js";
import { keepAliveUntilDone, rememberVerification } from "../src/requests.js";

const INVOCATION_ID = "var_invk_00000000000001";
const TOKEN = `var_nt_${"a".repeat(40)}`;
const NOTIFICATION_URL =
  `https://api.usevaris.com/v1/invocations/${INVOCATION_ID}/notifications`;
const DETAILS: VarisNotificationDetails = {
  invocationId: INVOCATION_ID,
  notificationToken: TOKEN,
  notificationUrl: NOTIFICATION_URL,
};
const URL_PATH = "/v1/render";
const BODY = JSON.stringify({ scene: "beach", frames: 1000 });

let signingKey: CryptoKey;
let publicKey: VarisPublicKey;

beforeEach(async () => {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  signingKey = pair.privateKey;
  publicKey = {
    kid: "k1",
    public_key_pem: `-----BEGIN PUBLIC KEY-----\n${btoa(String.fromCharCode(...spki))}\n-----END PUBLIC KEY-----`,
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The headers the gateway sends with a POST to URL_PATH. */
async function gatewayHeaders(): Promise<Record<string, string>> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "Ed25519" },
      signingKey,
      new TextEncoder().encode(`${timestamp}.${INVOCATION_ID}.POST.${URL_PATH}.${BODY}`),
    ),
  );
  return {
    "content-type": "application/json",
    "x-varis-request-id": "var_req_1",
    "x-varis-invocation-id": INVOCATION_ID,
    "x-varis-notification-token": TOKEN,
    "x-varis-timestamp": timestamp,
    "x-varis-signature": btoa(String.fromCharCode(...signature)),
    "x-varis-key-id": "k1",
  };
}

async function varisWebRequest(): Promise<Request> {
  return new Request(`https://provider.example.com${URL_PATH}`, {
    method: "POST",
    headers: await gatewayHeaders(),
    body: BODY,
  });
}

function userWebRequest(): Request {
  return new Request(`https://provider.example.com${URL_PATH}`, {
    method: "POST",
    headers: { authorization: "Bearer user-token", "content-type": "application/json" },
    body: BODY,
  });
}

/**
 * Stands in for Varis's notification route: answers each notification with
 * the next of `answers`, the last repeating, and records what was sent.
 */
function varisNotifications(...answers: Array<() => Response | Promise<Response>>) {
  const sent: unknown[] = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe(NOTIFICATION_URL);
    sent.push(JSON.parse(String(init?.body)));
    const answer = answers.length > 1 ? answers.shift()! : answers[0];
    return answer ? answer() : Response.json({ continue: true });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { sent, fetchMock };
}

const keepGoing = () => Response.json({ continue: true });
const stop = () => Response.json({ continue: false });

/** Resolves to `value` after `ms`. */
function after<Value>(ms: number, value: Value): Promise<Value> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/** Rejects with `error` after `ms`. */
function failAfter(ms: number, error: Error): Promise<never> {
  return new Promise((_resolve, reject) => setTimeout(() => reject(error), ms));
}

/** A provider's Next.js route: its own user check, then the work. */
async function webRoute(
  varis: Varis,
  request: Request,
  work: () => Promise<Response>,
): Promise<Response> {
  const isVaris = await varis.requests.verify(request);
  const isUser = request.headers.get("authorization") === "Bearer user-token";
  if (!isUser && !isVaris) return new Response("Unauthorised", { status: 401 });
  return await varis.requests.handleOnServer(request, work()) as Response;
}

/** Fakes the timers the SDK uses, leaving the rest for crypto and fetch. */
function fakeTimers() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
}

describe("requests.handleOnServer, Web style", () => {
  it("gives a normal user the work's own answer, without notifying Varis", async () => {
    const { fetchMock } = varisNotifications();
    const varis = new Varis({ publicKeys: [publicKey] });
    const answer = Response.json({ id: 1 });

    expect(await webRoute(varis, userWebRequest(), async () => answer)).toBe(answer);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes a fast answer through unchanged, verifying once", async () => {
    const { fetchMock } = varisNotifications();
    const varis = new Varis({ publicKeys: [publicKey] });
    const verifySignature = vi.spyOn(crypto.subtle, "verify");
    const answer = Response.json({ frames: 1000 });

    expect(await webRoute(varis, await varisWebRequest(), async () => answer)).toBe(answer);
    expect(verifySignature).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rethrows an error thrown in time, without notifying Varis", async () => {
    const { fetchMock } = varisNotifications();
    const varis = new Varis({ publicKeys: [publicKey] });
    const error = new Error("bad scene");

    await expect(
      webRoute(varis, await varisWebRequest(), () => Promise.reject(error)),
    ).rejects.toBe(error);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 202 at 20 s, heartbeats 30 s later, then sends the result", async () => {
    const { sent } = varisNotifications(keepGoing, stop);
    const varis = new Varis({ publicKeys: [publicKey] });
    const request = await varisWebRequest();
    await varis.requests.verify(request);
    fakeTimers();

    const responding = webRoute(varis, request, () =>
      after(55_000, Response.json({ frames: 1000 })));
    await vi.advanceTimersByTimeAsync(19_999);
    expect(await Promise.race([responding, "waiting"])).toBe("waiting");
    await vi.advanceTimersByTimeAsync(1);
    const response = await responding;
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "started" });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual([{ status: "running" }]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent).toEqual([
      { status: "running" },
      { status: "completed", result: { frames: 1000 } },
    ]);
  });

  it("sends failed for a non-2xx answer after 202", async () => {
    const { sent } = varisNotifications(stop);
    const varis = new Varis({ publicKeys: [publicKey] });
    const request = await varisWebRequest();
    await varis.requests.verify(request);
    fakeTimers();

    void webRoute(varis, request, () =>
      after(25_000, Response.json({ stack: "db.ts:12" }, { status: 500 })));
    await vi.advanceTimersByTimeAsync(25_000);

    expect(sent).toEqual([{ status: "failed" }]);
  });

  it("sends failed, with no message, when the work throws after 202", async () => {
    const { sent } = varisNotifications(stop);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const varis = new Varis({ publicKeys: [publicKey] });
    const request = await varisWebRequest();
    await varis.requests.verify(request);
    fakeTimers();

    void webRoute(varis, request, () => failAfter(25_000, new Error("GPU at 0x7f3a")));
    await vi.advanceTimersByTimeAsync(25_000);

    expect(sent).toEqual([{ status: "failed" }]);
    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
  });

  it("stops heartbeats and sends no result once Varis says stop", async () => {
    const { sent } = varisNotifications(stop);
    const varis = new Varis({ publicKeys: [publicKey] });
    const request = await varisWebRequest();
    await varis.requests.verify(request);
    fakeTimers();

    void webRoute(varis, request, () => after(200_000, Response.json({ frames: 1 })));
    await vi.advanceTimersByTimeAsync(200_000);

    expect(sent).toEqual([{ status: "running" }]);
  });

  it("sends no result when delegateToWorker was also called", async () => {
    const { sent } = varisNotifications(keepGoing);
    const varis = new Varis({ publicKeys: [publicKey] });
    const request = await varisWebRequest();
    await varis.requests.verify(request);
    fakeTimers();

    void webRoute(varis, request, async () => {
      await after(25_000, null);
      await varis.requests.delegateToWorker(request);
      return Response.json({ queued: true });
    });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(sent).toEqual([{ status: "started" }]);
  });

  it("passes on a request without notification headers", async () => {
    const { fetchMock } = varisNotifications();
    const varis = new Varis({ publicKeys: [publicKey] });
    const headers = await gatewayHeaders();
    delete headers["x-varis-notification-token"];
    const request = new Request(`https://provider.example.com${URL_PATH}`, {
      method: "POST",
      headers,
      body: BODY,
    });
    await varis.requests.verify(request);
    fakeTimers();

    const responding = webRoute(varis, request, () => after(25_000, Response.json({})));
    await vi.advanceTimersByTimeAsync(25_000);

    expect((await responding).status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the function alive with the waitUntil option", async () => {
    varisNotifications(stop);
    const waitUntil = vi.fn();
    const varis = new Varis({ publicKeys: [publicKey], waitUntil });
    const request = await varisWebRequest();
    await varis.requests.verify(request);
    fakeTimers();

    void webRoute(varis, request, () => after(25_000, Response.json({})));
    await vi.advanceTimersByTimeAsync(20_000);

    expect(waitUntil).toHaveBeenCalledOnce();
    expect(waitUntil.mock.calls[0]![0]).toBeInstanceOf(Promise);
  });
});

/**
 * A Node res with Express's status and json. Like Node's, it throws
 * ERR_HTTP_HEADERS_SENT when written to after its headers went out.
 */
class FakeExpressResponse implements NodeResponse {
  statusCode = 200;
  headersSent = false;
  writableEnded = false;
  /** What reached the client. */
  sent: { status: number; body: string } | undefined;
  #body = "";

  setHeader(_name: string, _value: unknown) {
    this.#refuseIfSent();
    return this;
  }
  writeHead(statusCode: number) {
    this.#refuseIfSent();
    this.statusCode = statusCode;
    this.headersSent = true;
    return this;
  }
  write(chunk: unknown) {
    if (!this.headersSent) this.writeHead(this.statusCode);
    this.#body += String(chunk);
    return true;
  }
  end(chunk?: unknown) {
    if (chunk !== undefined && typeof chunk !== "function") this.write(chunk);
    else if (!this.headersSent) this.writeHead(this.statusCode);
    this.writableEnded = true;
    this.sent = { status: this.statusCode, body: this.#body };
    return this;
  }
  status(code: number) {
    this.statusCode = code;
    return this;
  }
  json(body: unknown) {
    this.setHeader("content-type", "application/json");
    this.end(JSON.stringify(body));
    return this;
  }
  #refuseIfSent() {
    if (this.headersSent) {
      throw Object.assign(new Error("Cannot set headers after they are sent"), {
        code: "ERR_HTTP_HEADERS_SENT",
      });
    }
  }
}

interface ExpressRequest extends NodeRequest {
  res: FakeExpressResponse;
}

async function varisExpressRequest(): Promise<ExpressRequest> {
  return {
    method: "POST",
    url: "/render",
    originalUrl: URL_PATH,
    headers: await gatewayHeaders(),
    body: JSON.parse(BODY),
    res: new FakeExpressResponse(),
  };
}

/** A provider's Express route: its own user check, then the controller. */
async function expressRoute(
  varis: Varis,
  req: ExpressRequest,
  controller: (req: ExpressRequest, res: FakeExpressResponse) => Promise<unknown>,
) {
  const isVaris = await varis.requests.verify(req);
  const isUser = req.headers.authorization === "Bearer user-token";
  if (!isUser && !isVaris) return req.res.status(401).json({ message: "Unauthorised" });
  return varis.requests.handleOnServer(req, controller(req, req.res));
}

describe("requests.handleOnServer, Express style", () => {
  it("gives a normal user the controller's own answer", async () => {
    const { fetchMock } = varisNotifications();
    const varis = new Varis({ publicKeys: [publicKey] });
    const req = { ...(await varisExpressRequest()), headers: { authorization: "Bearer user-token" } };

    await expressRoute(varis, req, async (_req, res) => res.json({ id: 1 }));

    expect(req.res.sent).toEqual({ status: 200, body: '{"id":1}' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes an answer written before handleOnServer runs", async () => {
    const { fetchMock } = varisNotifications();
    const varis = new Varis({ publicKeys: [publicKey] });
    const req = await varisExpressRequest();

    await expressRoute(varis, req, async (_req, res) => {
      res.status(400).json({ message: "Missing scene" });
    });

    expect(req.res.sent).toEqual({ status: 400, body: '{"message":"Missing scene"}' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes a fast answer through and returns the controller's value", async () => {
    const { fetchMock } = varisNotifications();
    const varis = new Varis({ publicKeys: [publicKey] });
    const req = await varisExpressRequest();
    await varis.requests.verify(req);
    fakeTimers();

    const handling = expressRoute(varis, req, async (_req, res) => {
      await after(5_000, null);
      res.status(201).json({ frames: 1000 });
      return "done";
    });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await handling).toBe("done");
    expect(req.res.sent).toEqual({ status: 201, body: '{"frames":1000}' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("writes 202 at 20 s, then sends the controller's later answer as the result", async () => {
    const { sent } = varisNotifications(keepGoing, stop);
    const varis = new Varis({ publicKeys: [publicKey] });
    const req = await varisExpressRequest();
    await varis.requests.verify(req);
    fakeTimers();
    let controllerError: unknown;

    void expressRoute(varis, req, async (_req, res) => {
      await after(55_000, null);
      try {
        res.json({ frames: 1000 });
      } catch (error) {
        controllerError = error;
      }
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(req.res.sent).toEqual({ status: 202, body: '{"status":"started"}' });

    await vi.advanceTimersByTimeAsync(35_000);
    expect(controllerError).toBeUndefined();
    expect(sent).toEqual([
      { status: "running" },
      { status: "completed", result: { frames: 1000 } },
    ]);
    expect(req.res.sent).toEqual({ status: 202, body: '{"status":"started"}' });
  });

  it("sends failed when the controller throws after 202", async () => {
    const { sent } = varisNotifications(stop);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const varis = new Varis({ publicKeys: [publicKey] });
    const req = await varisExpressRequest();
    await varis.requests.verify(req);
    fakeTimers();

    void expressRoute(varis, req, () => failAfter(25_000, new Error("GPU at 0x7f3a")));
    await vi.advanceTimersByTimeAsync(25_000);

    expect(sent).toEqual([{ status: "failed" }]);
  });

  it("sends failed for a later error status", async () => {
    const { sent } = varisNotifications(stop);
    const varis = new Varis({ publicKeys: [publicKey] });
    const req = await varisExpressRequest();
    await varis.requests.verify(req);
    fakeTimers();

    void expressRoute(varis, req, async (_req, res) => {
      await after(25_000, null);
      res.status(500).json({ message: "db down" });
    });
    await vi.advanceTimersByTimeAsync(25_000);

    expect(sent).toEqual([{ status: "failed" }]);
  });

  it("leaves a streaming answer alone", async () => {
    const { fetchMock } = varisNotifications();
    const varis = new Varis({ publicKeys: [publicKey] });
    const req = await varisExpressRequest();
    await varis.requests.verify(req);
    fakeTimers();

    void expressRoute(varis, req, async (_req, res) => {
      await after(10_000, null);
      res.write("frame 1\n");
      await after(20_000, null);
      res.end("frame 2\n");
    });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(req.res.sent).toEqual({ status: 200, body: "frame 1\nframe 2\n" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("requests.delegateToWorker", () => {
  it("returns null for a normal user, without a network call", async () => {
    const { fetchMock } = varisNotifications();
    const varis = new Varis({ publicKeys: [publicKey] });

    expect(await varis.requests.delegateToWorker(userWebRequest())).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends started and waits for Varis to confirm before returning", async () => {
    let confirm!: (response: Response) => void;
    const { sent } = varisNotifications(
      () => new Promise<Response>((resolve) => (confirm = resolve)),
    );
    const varis = new Varis({ publicKeys: [publicKey] });

    const delegating = varis.requests.delegateToWorker(await varisWebRequest());
    await vi.waitFor(() => expect(sent).toEqual([{ status: "started" }]));
    expect(await Promise.race([delegating, "waiting"])).toBe("waiting");
    confirm(keepGoing());

    expect(await delegating).toEqual(DETAILS);
  });

  it("works with an Express req", async () => {
    varisNotifications(keepGoing);
    const varis = new Varis({ publicKeys: [publicKey] });

    expect(await varis.requests.delegateToWorker(await varisExpressRequest())).toEqual(
      DETAILS,
    );
  });

  it("sends to the origin of keysUrl", async () => {
    const fetchMock = vi.fn(async () => keepGoing());
    vi.stubGlobal("fetch", fetchMock);
    const varis = new Varis({
      publicKeys: [publicKey],
      keysUrl: "http://localhost:3000/.well-known/varis-signing-keys",
    });

    const details = await varis.requests.delegateToWorker(await varisWebRequest());

    expect(details?.notificationUrl).toBe(
      `http://localhost:3000/v1/invocations/${INVOCATION_ID}/notifications`,
    );
    expect(fetchMock.mock.calls[0]).toContain(details?.notificationUrl);
  });

  it("throws when Varis can't be reached", async () => {
    varisNotifications(() => new Response("down", { status: 503 }));
    const varis = new Varis({ publicKeys: [publicKey] });
    const request = await varisWebRequest();
    await varis.requests.verify(request);
    fakeTimers();

    const delegating = varis.requests.delegateToWorker(request);
    const failed = expect(delegating).rejects.toThrow(/couldn't be told/);
    await vi.advanceTimersByTimeAsync(20_000);

    await failed;
  });

  it("throws when the call has already ended", async () => {
    varisNotifications(() => Response.json({ continue: false }, { status: 410 }));
    const varis = new Varis({ publicKeys: [publicKey] });

    await expect(varis.requests.delegateToWorker(await varisWebRequest())).rejects.toThrow(
      /already ended/,
    );
  });
});

describe("requests.handleInWorker", () => {
  it.each([null, undefined])("just runs the job with %s details", async (details) => {
    const { fetchMock } = varisNotifications();
    const varis = new Varis();

    expect(await varis.requests.handleInWorker(details, async () => "rendered")).toBe(
      "rendered",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends running at once and every 30 s, then the result, and returns it", async () => {
    const { sent } = varisNotifications(keepGoing, keepGoing, keepGoing, stop);
    fakeTimers();

    const handling = new Varis().requests.handleInWorker(DETAILS, () =>
      after(70_000, { frames: 1000 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([{ status: "running" }]);
    await vi.advanceTimersByTimeAsync(70_000);

    expect(await handling).toEqual({ frames: 1000 });
    expect(sent).toEqual([
      { status: "running" },
      { status: "running" },
      { status: "running" },
      { status: "completed", result: { frames: 1000 } },
    ]);
  });

  it("sends failed and rethrows the job's error", async () => {
    const { sent } = varisNotifications(keepGoing, stop);
    const error = new Error("GPU at 0x7f3a");

    await expect(
      new Varis().requests.handleInWorker(DETAILS, () => Promise.reject(error)),
    ).rejects.toBe(error);
    expect(sent).toEqual([{ status: "running" }, { status: "failed" }]);
  });

  it("treats a synchronous throw as the job failing", async () => {
    const { sent } = varisNotifications(keepGoing, stop);
    const error = new Error("bad input");

    await expect(
      new Varis().requests.handleInWorker(DETAILS, () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(sent).toContainEqual({ status: "failed" });
  });
});

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
    const varis = new Varis({ publicKeys: [publicKey] });
    const request = await varisWebRequest();
    const verifySignature = vi.spyOn(crypto.subtle, "verify");

    expect(await varis.requests.verify(request)).toBe(true);
    expect(await varis.requests.verify(request)).toBe(true);

    expect(verifySignature).toHaveBeenCalledOnce();
  });
});
