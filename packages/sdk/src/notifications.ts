/**
 * notifications.ts: tells Varis how a long call is going, from the process
 * doing the work.
 *
 * WIRE FORMAT (must match the notification route in the private varis repo,
 * app/api/v1/invocations/[invocation_id]/notifications)
 * - `POST ${apiOrigin}/v1/invocations/${invocationId}/notifications`, with
 *   `Authorization: Bearer ${notificationToken}` and a JSON body of
 *   `{"status":"started"}`, `{"status":"running"}`,
 *   `{"status":"completed","result":…}`, or `{"status":"failed"}`.
 * - Every answer carries `continue`. False means the call is over: stop
 *   reporting on it and don't send its result. It never stops the work.
 *
 * The URL is built from the SDK's own origin, never from a request header,
 * so a forged request can't send the token anywhere else. A `varis test`
 * request reports to the CLI on the developer's loopback instead.
 *
 * A failed call's notification carries no message, so a provider's internal
 * errors never reach Varis or the agent.
 */
import { LOCAL_TEST_NOTIFICATIONS_URL } from "./constants.js";
import type { RequestParts } from "./request-parts.js";
import { isTestRequest } from "./verify.js";

/** What's needed to report on one call. Plain JSON, so it fits in a queue message. */
export interface VarisNotificationDetails {
  invocationId: string;
  notificationToken: string;
  notificationUrl: string;
}

export type Notification =
  | { status: "started" }
  | { status: "running" }
  | { status: "completed"; result: unknown }
  | { status: "failed"; reason?: "output_too_large" };

export interface NotificationOutcome {
  /** Varis recorded the notification. */
  delivered: boolean;
  /** False once the call is over. True when Varis can't be reached. */
  continue: boolean;
}

/** When to give up on a notification Varis didn't answer. */
export interface RetrySchedule {
  /** The wait before each retry. Its length is the number of retries. */
  delaysMs: readonly number[];
  /** How long one attempt may take. */
  attemptTimeoutMs: number;
  /** No attempt starts that could end later than this after the first. */
  giveUpAfterMs: number;
}

/** A heartbeat every 30 seconds keeps a call inside Varis's 5-minute silence limit. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** Varis fails a larger result as `output_too_large`, so it isn't sent. */
export const MAX_RESULT_BYTES = 4 * 1024 * 1024;

/** A result: 6 retries, 1 to 32 seconds apart. */
export const RESULT_RETRIES: RetrySchedule = {
  delaysMs: [1_000, 2_000, 4_000, 8_000, 16_000, 32_000],
  attemptTimeoutMs: 10_000,
  giveUpAfterMs: Number.POSITIVE_INFINITY,
};

/**
 * `started` from a route that hands its call to a worker. It must be
 * confirmed before the route answers, inside the gateway's 30-second limit.
 */
export const STARTED_RETRIES: RetrySchedule = {
  delaysMs: [1_000, 2_000, 4_000, 8_000],
  attemptTimeoutMs: 5_000,
  giveUpAfterMs: 20_000,
};

/** A heartbeat isn't retried: the next one comes 30 seconds later. */
export const HEARTBEAT_RETRIES: RetrySchedule = {
  delaysMs: [],
  attemptTimeoutMs: 10_000,
  giveUpAfterMs: Number.POSITIVE_INFINITY,
};

/** The invocation ID goes in a URL path, so it may only hold these. */
const INVOCATION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
/** The token goes in a header, so it may only hold visible ASCII. */
const TOKEN_PATTERN = /^[\x21-\x7e]+$/;
const encoder = new TextEncoder();

/** Where notifications for a call go. Never read from the request (D7). */
export function buildNotificationUrl(
  invocationId: string,
  isTest: boolean,
  apiOrigin: string,
): string {
  const id = encodeURIComponent(invocationId);
  return isTest
    ? `${LOCAL_TEST_NOTIFICATIONS_URL}?invocation_id=${id}`
    : `${apiOrigin}/v1/invocations/${id}/notifications`;
}

/**
 * The notification details of a request already verified as from Varis, or
 * null when either header is missing or malformed.
 */
export function readNotificationDetails(
  request: RequestParts,
  apiOrigin: string,
): VarisNotificationDetails | null {
  const invocationId = request.header("x-varis-invocation-id");
  const notificationToken = request.header("x-varis-notification-token");
  if (!invocationId || !INVOCATION_ID_PATTERN.test(invocationId)) return null;
  if (!notificationToken || !TOKEN_PATTERN.test(notificationToken)) return null;
  return {
    invocationId,
    notificationToken,
    notificationUrl: buildNotificationUrl(
      invocationId,
      isTestRequest(request),
      apiOrigin,
    ),
  };
}

/**
 * Sends one notification. Retries network errors, timeouts, `5xx`, and
 * `429` (after its `Retry-After`), on `schedule`. Any other answer is final.
 */
export async function sendNotification(
  details: VarisNotificationDetails,
  notification: Notification,
  schedule: RetrySchedule = RESULT_RETRIES,
): Promise<NotificationOutcome> {
  const firstAttemptAt = Date.now();
  for (let retry = 0; ; retry++) {
    const attempt = await postNotification(
      details,
      notification,
      schedule.attemptTimeoutMs,
    );
    if (attempt.final) return attempt.outcome;

    const scheduled = schedule.delaysMs[retry];
    if (scheduled === undefined) break;
    const delay = attempt.retryAfterMs ?? scheduled;
    const endsAt = Date.now() - firstAttemptAt + delay +
      schedule.attemptTimeoutMs;
    if (endsAt > schedule.giveUpAfterMs) break;
    await sleep(delay);
  }
  return { delivered: false, continue: true };
}

type Attempt =
  | { final: true; outcome: NotificationOutcome }
  | { final: false; retryAfterMs?: number };

async function postNotification(
  details: VarisNotificationDetails,
  notification: Notification,
  timeoutMs: number,
): Promise<Attempt> {
  let response: Response;
  try {
    response = await fetch(details.notificationUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${details.notificationToken}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(notification),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { final: false };
  }

  if (response.status === 429 || response.status >= 500) {
    void response.body?.cancel().catch(() => {});
    const retryAfterMs = readRetryAfterMs(response);
    return retryAfterMs === undefined
      ? { final: false }
      : { final: false, retryAfterMs };
  }
  return {
    final: true,
    outcome: { delivered: response.ok, continue: await readContinue(response) },
  };
}

/** `Retry-After` in milliseconds, when it's a number of seconds. */
function readRetryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value || !/^\d+$/.test(value.trim())) return undefined;
  return Number(value) * 1_000;
}

/** The answer's `continue`. True when the body doesn't say. */
async function readContinue(response: Response): Promise<boolean> {
  try {
    const body = await response.json() as { continue?: unknown } | null;
    return typeof body?.continue === "boolean" ? body.continue : true;
  } catch {
    return true;
  }
}

export interface NotificationTimer {
  stop(): void;
  /** Whether Varis answered `continue: false`. */
  stoppedByVaris(): boolean;
}

/**
 * Sends a `running` heartbeat every 30 seconds until stopped, or until
 * Varis answers `continue: false`. `beatNow` sends the first one at once.
 */
export function startNotificationTimer(
  details: VarisNotificationDetails,
  options: { beatNow?: boolean } = {},
): NotificationTimer {
  let stopped = false;
  let stoppedByVaris = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const beat = async () => {
    const outcome = await sendNotification(
      details,
      { status: "running" },
      HEARTBEAT_RETRIES,
    );
    if (!outcome.continue) stoppedByVaris = true;
    if (stopped || stoppedByVaris) return;
    timeout = setTimeout(beat, HEARTBEAT_INTERVAL_MS);
  };

  if (options.beatNow) void beat();
  else timeout = setTimeout(beat, HEARTBEAT_INTERVAL_MS);

  return {
    stop() {
      stopped = true;
      clearTimeout(timeout);
    },
    stoppedByVaris: () => stoppedByVaris,
  };
}

/**
 * Reports on a job until it ends: heartbeats while it runs, then its
 * result, unless Varis said stop or `isReportedElsewhere` says another
 * process reports it. `describe` turns the job's value into the final
 * notification; by default the value is the result.
 *
 * Returns the job's value, or rethrows its error, so the caller sees what
 * it would without the SDK.
 */
export async function reportJobUntilDone<Value>(
  details: VarisNotificationDetails,
  job: Promise<Value>,
  options: {
    describe?: (value: Value) => Notification;
    beatNow?: boolean;
    isReportedElsewhere?: () => boolean;
  } = {},
): Promise<Value> {
  const timer = startNotificationTimer(details, { beatNow: options.beatNow });
  const settled = await settle(job);
  timer.stop();

  if (!timer.stoppedByVaris() && !options.isReportedElsewhere?.()) {
    const final = settled.ok
      ? (options.describe ?? describeAsResult)(settled.value)
      : { status: "failed" as const };
    await sendNotification(details, checkResult(final));
  }

  if (!settled.ok) throw settled.error;
  return settled.value;
}

function describeAsResult(value: unknown): Notification {
  return { status: "completed", result: value };
}

/**
 * The notification to send for `notification`: a result over 4 MB of JSON,
 * or one that isn't JSON at all, becomes a failure. A missing result is
 * `null`, so the route still finds one.
 */
export function checkResult(notification: Notification): Notification {
  if (notification.status !== "completed") return notification;
  const result = notification.result ?? null;
  let json: string;
  try {
    json = JSON.stringify(result);
  } catch {
    return { status: "failed" };
  }
  if (encoder.encode(json).length > MAX_RESULT_BYTES) {
    return { status: "failed", reason: "output_too_large" };
  }
  return { status: "completed", result };
}

type Settled<Value> =
  | { ok: true; value: Value }
  | { ok: false; error: unknown };

async function settle<Value>(job: Promise<Value>): Promise<Settled<Value>> {
  try {
    return { ok: true, value: await job };
  } catch (error) {
    return { ok: false, error };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
