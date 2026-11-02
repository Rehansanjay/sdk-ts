/**
 * requests.ts: `varis.requests`, the calls a provider drops into an
 * existing route.
 *
 * Each call works on its own and is one line in the route. None wraps a
 * whole route or assumes the route exists only for Varis: the route keeps
 * serving its own users, and calls that aren't from Varis pass through
 * untouched.
 *
 * TIMING (must match the gateway in the private varis repo)
 * The gateway waits 30 seconds for the first answer. `handleOnServer`
 * answers `202 started` itself when the work hasn't answered after 20 seconds,
 * then reports from the server. `delegateToWorker` tells Varis "started" before
 * the route answers, and `handleInWorker` reports from the worker. A call's
 * heartbeats always come from the process doing the work.
 */
import { VARIS_API_ORIGIN } from "./constants.js";
import { keepAliveUntilDone, type WaitUntil } from "./keep-alive.js";
import {
  type Notification,
  readNotificationDetails,
  reportJobUntilDone,
  sendNotification,
  STARTED_RETRIES,
  type VarisNotificationDetails,
} from "./notifications.js";
import {
  isWebRequest,
  type NodeResponse,
  readRequestParts,
  type VarisRequest,
} from "./request-parts.js";
import {
  computeResultFromResponse,
  computeResultFromValue,
  interceptExpressResponse,
  startedResponse,
  waitForQuickResponse,
} from "./responses.js";
import { RequestVerifier, type VarisOptions } from "./verify.js";

/** How long `handleOnServer` waits for the work before answering `202 started`. */
export const ACKNOWLEDGE_AFTER_MS = 20_000;

/** What the SDK remembers about one request. */
interface RequestRecord {
  /** What `verify` answered, shared by every later call. */
  isVaris?: Promise<boolean>;
  /** `delegateToWorker` handed the call to a worker, which reports its result. */
  delegated?: boolean;
}

/**
 * The record for `request`, created on first use. Kept in a WeakMap, so it
 * goes when the request does.
 */
export function rememberVerification(
  records: WeakMap<object, RequestRecord>,
  request: VarisRequest,
): RequestRecord {
  let record = records.get(request);
  if (!record) {
    record = {};
    records.set(request, record);
  }
  return record;
}

export class VarisRequestHandler {
  readonly #verifier: RequestVerifier;
  readonly #records = new WeakMap<object, RequestRecord>();
  readonly #keysUrl: string | undefined;
  readonly #waitUntil: WaitUntil | undefined;

  constructor(options: VarisOptions) {
    this.#verifier = new RequestVerifier(options);
    this.#keysUrl = options.keysUrl;
    this.#waitUntil = options.waitUntil;
  }

  /**
   * Checks that `request` was signed by the Varis gateway. Accepts a Web
   * `Request` or a Node.js `req`, such as Express's. Call it before you read
   * the body. A Web body stays readable afterward; a Node `req` needs a JSON
   * body parser, such as `express.json()`, to have run first.
   *
   * Resolves to false for any invalid or unsigned request. Rejects with
   * `VarisKeyFetchError` only when the signing keys can't be loaded.
   */
  verify(request: VarisRequest): Promise<boolean> {
    const record = rememberVerification(this.#records, request);
    record.isVaris ??= this.#verifier.verify(readRequestParts(request));
    return record.isVaris;
  }

  /**
   * Handles the request on the server. `work` is the route's existing
   * controller call, such as `renderController(req, res)`.
   *
   * A request that isn't from Varis gets the work's own answer, untouched,
   * and so does a Varis request the work answers within 20 seconds.
   * Otherwise Varis gets `202 started`, and the work's answer is sent to
   * Varis as its result when it's ready.
   *
   * Web-style work resolves to a `Response`. Express-style work writes to
   * `res`, which the SDK finds at `req.res`; after `202 started`, ignore
   * what this resolves to, since the SDK has already answered.
   */
  async handleOnServer<Result>(
    request: VarisRequest,
    work: Promise<Result>,
  ): Promise<Result | Response> {
    const startedAt = Date.now();
    // Handled now, so a rejection while verifying isn't reported as
    // unhandled. The work's error still reaches the caller below.
    work.catch(() => {});

    const details = await this.#readDetails(request);
    if (!details) return await work;
    const limitMs = ACKNOWLEDGE_AFTER_MS - (Date.now() - startedAt);
    const record = rememberVerification(this.#records, request);

    if (isWebRequest(request)) {
      return await this.#handleWebWork(details, work, limitMs, record);
    }
    // Without a res, as with plain node:http, the SDK can't answer for it.
    const res = request.res;
    if (!res || res.writableEnded || res.headersSent) return await work;
    return await this.#handleExpressWork(details, work, res, limitMs, record);
  }

  /**
   * Hands the request to a worker. Tells Varis "started", and waits for
   * Varis to confirm, so Varis ignores what the route answers. Returns the
   * notification details to put in the queue message, or null for a request
   * that isn't from Varis.
   *
   * Throws when Varis can't be told, or the call has already ended. Let the
   * route fail, and don't queue the job: Varis refunds the call.
   */
  async delegateToWorker(
    request: VarisRequest,
  ): Promise<VarisNotificationDetails | null> {
    const details = await this.#readDetails(request);
    if (!details) return null;

    const outcome = await sendNotification(
      details,
      { status: "started" },
      STARTED_RETRIES,
    );
    if (!outcome.continue) {
      throw new Error(
        `Varis call ${details.invocationId} has already ended. Don't queue a job for it.`,
      );
    }
    if (!outcome.delivered) {
      throw new Error(
        `Varis couldn't be told that call ${details.invocationId} went to a ` +
          "worker. Don't queue a job for it: let the route fail, and Varis " +
          "refunds the call.",
      );
    }
    rememberVerification(this.#records, request).delegated = true;
    return details;
  }

  /**
   * Handles the request in the worker. Runs the job, and keeps Varis
   * informed from the worker until it ends: `running` at once and every 30
   * seconds, then the job's value as the result, or `failed` if it throws.
   *
   * With null or missing details, as for a job a normal user queued, it
   * just runs the job. Either way it returns the job's value or rethrows
   * its error.
   */
  async handleInWorker<Output>(
    notificationDetails: VarisNotificationDetails | null | undefined,
    runJob: () => Promise<Output>,
  ): Promise<Output> {
    if (!notificationDetails) return await runJob();
    return await reportJobUntilDone(notificationDetails, startJob(runJob), {
      beatNow: true,
    });
  }

  /** The notification details of a Varis request, or null for any other. */
  async #readDetails(
    request: VarisRequest,
  ): Promise<VarisNotificationDetails | null> {
    if (!(await this.verify(request))) return null;
    const apiOrigin = this.#keysUrl
      ? new URL(this.#keysUrl).origin
      : VARIS_API_ORIGIN;
    return readNotificationDetails(readRequestParts(request), apiOrigin);
  }

  async #handleWebWork<Result>(
    details: VarisNotificationDetails,
    work: Promise<Result>,
    limitMs: number,
    record: RequestRecord,
  ): Promise<Result | Response> {
    const quick = await waitForQuickResponse(work, limitMs);
    if (quick.answered) return quick.response;

    this.#reportInBackground(
      details,
      work.then(computeResultFromValue),
      record,
    );
    return startedResponse();
  }

  async #handleExpressWork<Result>(
    details: VarisNotificationDetails,
    work: Promise<Result>,
    res: NodeResponse,
    limitMs: number,
    record: RequestRecord,
  ): Promise<Result | Response> {
    const interception = interceptExpressResponse(res);
    // Rejects when the work throws; never resolves, since the work's answer
    // is what it writes to res, not what it returns.
    const workThrows = work.then(() => new Promise<never>(() => {}));

    const quick = await waitForQuickResponse(
      Promise.race([interception.ended, workThrows]),
      limitMs,
    );
    // A response already streaming can't be replaced by 202 started.
    if (quick.answered || res.headersSent) return await work;

    const answer = Promise.race([interception.answerStarted(), workThrows])
      .then((captured) =>
        computeResultFromResponse(captured.statusCode, captured.body)
      );
    this.#reportInBackground(details, answer, record);
    return startedResponse();
  }

  /**
   * Reports on the work after Varis was told it started, without the
   * route waiting. A worker that took the call over reports its result.
   */
  #reportInBackground(
    details: VarisNotificationDetails,
    result: Promise<Notification>,
    record: RequestRecord,
  ): void {
    const reporting = reportJobUntilDone(details, result, {
      describe: (notification) => notification,
      isReportedElsewhere: () => record.delegated === true,
    }).catch((error: unknown) => {
      // Varis was told it failed. Nothing else would show the error.
      console.error(
        `Varis: the work for call ${details.invocationId} failed after Varis was told it started.`,
        error,
      );
    });
    keepAliveUntilDone(reporting, this.#waitUntil);
  }
}

/** Starts the job, turning a synchronous throw into a rejection. */
function startJob<Output>(runJob: () => Promise<Output>): Promise<Output> {
  return new Promise((resolve) => resolve(runJob()));
}
