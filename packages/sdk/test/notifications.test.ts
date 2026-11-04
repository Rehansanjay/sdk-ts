import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildNotificationUrl,
  checkResult,
  HEARTBEAT_INTERVAL_MS,
  MAX_RESULT_BYTES,
  readNotificationDetails,
  reportJobUntilDone,
  sendNotification,
  startNotificationTimer,
  STARTED_RETRIES,
  type VarisNotificationDetails,
} from "../src/notifications.js";
import { readRequestParts } from "../src/request-parts.js";

const API_ORIGIN = "https://api.usevaris.com";
const DETAILS: VarisNotificationDetails = {
  invocationId: "var_invk_00000000000001",
  notificationToken: `var_nt_${"a".repeat(40)}`,
  notificationUrl:
    "https://api.usevaris.com/v1/invocations/var_invk_00000000000001/notifications",
};

/** Stubs fetch with these answers, in order. The last one repeats. */
function varisAnswers(...answers: Array<Response | Error>) {
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const answer = answers.length > 1 ? answers.shift()! : answers[0]!;
    if (answer instanceof Error) throw answer;
    return answer.clone();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const keepGoing = () => Response.json({ continue: true });
const stop = () => Response.json({ continue: false });

/** The JSON bodies fetch was called with. */
function sentBodies(fetchMock: ReturnType<typeof varisAnswers>) {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("buildNotificationUrl", () => {
  it("builds the Varis URL from the API origin", () => {
    expect(buildNotificationUrl("var_invk_1", false, API_ORIGIN)).toBe(
      "https://api.usevaris.com/v1/invocations/var_invk_1/notifications",
    );
  });

  it("sends a test call's notifications to the CLI on the loopback", () => {
    expect(buildNotificationUrl("var_tst_invk_1", true, API_ORIGIN)).toBe(
      "http://127.0.0.1:47823/varis-test-notifications?invocation_id=var_tst_invk_1",
    );
  });
});

describe("readNotificationDetails", () => {
  const headers = {
    "x-varis-invocation-id": DETAILS.invocationId,
    "x-varis-notification-token": DETAILS.notificationToken,
  };

  it("reads the ID and token, and builds the URL itself", () => {
    const parts = readRequestParts({
      headers: { ...headers, "x-varis-notification-url": "https://evil.example.com" },
    });

    expect(readNotificationDetails(parts, API_ORIGIN)).toEqual(DETAILS);
  });

  it("uses the loopback for a request signed with the test key", () => {
    const parts = readRequestParts({
      headers: { ...headers, "x-varis-key-id": "varis-test" },
    });

    expect(readNotificationDetails(parts, API_ORIGIN)?.notificationUrl).toBe(
      "http://127.0.0.1:47823/varis-test-notifications?invocation_id=var_invk_00000000000001",
    );
  });

  it.each([
    ["no invocation ID", { "x-varis-notification-token": DETAILS.notificationToken }],
    ["no token", { "x-varis-invocation-id": DETAILS.invocationId }],
    ["an invocation ID that changes the path", { ...headers, "x-varis-invocation-id": ".." }],
    ["a token with a space", { ...headers, "x-varis-notification-token": "var_nt_ x" }],
  ])("returns null for %s", (_label, requestHeaders) => {
    const parts = readRequestParts({ headers: requestHeaders });

    expect(readNotificationDetails(parts, API_ORIGIN)).toBeNull();
  });
});

describe("sendNotification", () => {
  it("posts the notification with the token", async () => {
    const fetchMock = varisAnswers(keepGoing());

    const outcome = await sendNotification(DETAILS, { status: "running" });

    expect(outcome).toEqual({ delivered: true, continue: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(DETAILS.notificationUrl);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${DETAILS.notificationToken}`,
    );
    expect(sentBodies(fetchMock)).toEqual([{ status: "running" }]);
  });

  it("passes on continue false", async () => {
    varisAnswers(stop());

    expect(await sendNotification(DETAILS, { status: "running" })).toEqual({
      delivered: true,
      continue: false,
    });
  });

  it("retries 5xx and network errors 1, 2, 4, 8, 16, and 32 seconds apart", async () => {
    const fetchMock = varisAnswers(
      new Response("down", { status: 503 }),
      new TypeError("fetch failed"),
      Response.json({ continue: true }, { status: 500 }),
      keepGoing(),
    );

    const sending = sendNotification(DETAILS, { status: "completed", result: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(4_000);

    expect(await sending).toEqual({ delivered: true, continue: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("gives up after the last retry, saying Varis wasn't reached", async () => {
    const fetchMock = varisAnswers(new TypeError("fetch failed"));

    const sending = sendNotification(DETAILS, { status: "completed", result: 1 });
    await vi.advanceTimersByTimeAsync(63_000);

    expect(await sending).toEqual({ delivered: false, continue: true });
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it("waits for Retry-After on 429", async () => {
    const fetchMock = varisAnswers(
      Response.json({ continue: true }, { status: 429, headers: { "Retry-After": "30" } }),
      keepGoing(),
    );

    const sending = sendNotification(DETAILS, { status: "completed", result: 1 });
    await vi.advanceTimersByTimeAsync(29_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await sending).toEqual({ delivered: true, continue: true });
  });

  it.each([400, 401, 410, 413, 422])("doesn't retry %i", async (status) => {
    const fetchMock = varisAnswers(Response.json({ continue: false }, { status }));

    expect(await sendNotification(DETAILS, { status: "running" })).toEqual({
      delivered: false,
      continue: false,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("stops retrying started in time for the route to answer", async () => {
    const fetchMock = varisAnswers(new Response("down", { status: 503 }));

    const sending = sendNotification(DETAILS, { status: "started" }, STARTED_RETRIES);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(await sending).toEqual({ delivered: false, continue: true });
    // At 0, 1, 3, 7, and 15 seconds.
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("doesn't wait past its limit for a Retry-After", async () => {
    const fetchMock = varisAnswers(
      new Response(null, { status: 429, headers: { "Retry-After": "30" } }),
    );

    const sending = sendNotification(DETAILS, { status: "started" }, STARTED_RETRIES);

    expect(await sending).toEqual({ delivered: false, continue: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("startNotificationTimer", () => {
  it("sends running every 30 seconds until stopped", async () => {
    const fetchMock = varisAnswers(keepGoing());

    const timer = startNotificationTimer(DETAILS);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS - 1);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    timer.stop();
    await vi.advanceTimersByTimeAsync(5 * HEARTBEAT_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBodies(fetchMock)).toEqual([{ status: "running" }, { status: "running" }]);
    expect(timer.stoppedByVaris()).toBe(false);
  });

  it("sends the first at once with beatNow", async () => {
    const fetchMock = varisAnswers(keepGoing());

    const timer = startNotificationTimer(DETAILS, { beatNow: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledOnce();
    timer.stop();
  });

  it("stops when Varis answers continue false", async () => {
    const fetchMock = varisAnswers(keepGoing(), stop());

    const timer = startNotificationTimer(DETAILS);
    await vi.advanceTimersByTimeAsync(5 * HEARTBEAT_INTERVAL_MS);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(timer.stoppedByVaris()).toBe(true);
  });

  it("doesn't retry a heartbeat", async () => {
    const fetchMock = varisAnswers(new Response("down", { status: 503 }));

    const timer = startNotificationTimer(DETAILS);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS + 29_000);

    expect(fetchMock).toHaveBeenCalledOnce();
    timer.stop();
  });
});

describe("reportJobUntilDone", () => {
  /** A job that ends after `ms`. */
  function jobFor<Value>(ms: number, value: Value): Promise<Value> {
    return new Promise((resolve) => setTimeout(() => resolve(value), ms));
  }

  it("heartbeats while the job runs, then sends its result and returns it", async () => {
    const fetchMock = varisAnswers(keepGoing(), keepGoing(), stop());

    const reporting = reportJobUntilDone(DETAILS, jobFor(70_000, { frames: 1000 }));
    await vi.advanceTimersByTimeAsync(70_000);

    expect(await reporting).toEqual({ frames: 1000 });
    expect(sentBodies(fetchMock)).toEqual([
      { status: "running" },
      { status: "running" },
      { status: "completed", result: { frames: 1000 } },
    ]);
    await vi.advanceTimersByTimeAsync(5 * HEARTBEAT_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("sends failed, with no message, and rethrows a thrown error", async () => {
    const fetchMock = varisAnswers(stop());
    const error = new Error("GPU out of memory at 0x7f3a");

    await expect(reportJobUntilDone(DETAILS, Promise.reject(error))).rejects.toBe(error);
    expect(sentBodies(fetchMock)).toEqual([{ status: "failed" }]);
  });

  it("sends no result once Varis says stop", async () => {
    const fetchMock = varisAnswers(stop());

    const reporting = reportJobUntilDone(DETAILS, jobFor(45_000, "done"));
    await vi.advanceTimersByTimeAsync(45_000);

    expect(await reporting).toBe("done");
    expect(sentBodies(fetchMock)).toEqual([{ status: "running" }]);
  });

  it("sends no result when another process reports it", async () => {
    const fetchMock = varisAnswers(keepGoing());

    await reportJobUntilDone(DETAILS, Promise.resolve("done"), {
      isReportedElsewhere: () => true,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses describe to turn the value into the result", async () => {
    const fetchMock = varisAnswers(stop());

    await reportJobUntilDone(DETAILS, Promise.resolve(2), {
      describe: (value) => ({ status: "completed", result: { doubled: value * 2 } }),
    });

    expect(sentBodies(fetchMock)).toEqual([
      { status: "completed", result: { doubled: 4 } },
    ]);
  });

  it("retries the result", async () => {
    const fetchMock = varisAnswers(new Response("down", { status: 502 }), stop());

    const reporting = reportJobUntilDone(DETAILS, Promise.resolve("done"));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await reporting).toBe("done");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("checkResult", () => {
  it("keeps a result of 4 MB or less", () => {
    const result = "x".repeat(MAX_RESULT_BYTES - 2);

    expect(checkResult({ status: "completed", result })).toEqual({
      status: "completed",
      result,
    });
  });

  it("fails a result over 4 MB of JSON as output_too_large", () => {
    // Two bytes a character in UTF-8, so it's over the limit in bytes only.
    const result = "é".repeat(MAX_RESULT_BYTES / 2);

    expect(checkResult({ status: "completed", result })).toEqual({
      status: "failed",
      reason: "output_too_large",
    });
  });

  it("sends a missing result as null", () => {
    expect(checkResult({ status: "completed", result: undefined })).toEqual({
      status: "completed",
      result: null,
    });
  });

  it("fails a result that isn't JSON", () => {
    expect(checkResult({ status: "completed", result: { n: 1n } })).toEqual({
      status: "failed",
    });
  });
});
