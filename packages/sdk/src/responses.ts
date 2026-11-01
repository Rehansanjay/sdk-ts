/**
 * responses.ts: watches the work's answer, and turns it into what Varis
 * gets: the answer itself when it's quick, or `202 started` now and a
 * notification later.
 *
 * Web-style work resolves to a `Response`. Express-style work writes to
 * `res` instead, so `interceptExpressResponse` watches `res.end`.
 */
import type { Notification } from "./notifications.js";
import type { NodeResponse } from "./request-parts.js";

/** The body of a `202` that tells Varis the call has started. */
const STARTED_BODY = JSON.stringify({ status: "started" });

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Tells Varis the call has started and its result comes by notification. */
export function startedResponse(): Response {
  return new Response(STARTED_BODY, {
    status: 202,
    headers: { "content-type": "application/json" },
  });
}

export type QuickResponse<Answer> =
  | { answered: true; response: Answer }
  | { answered: false };

/**
 * Waits up to `limitMs` for `answer`. Rejects if `answer` rejects in that
 * time, so a thrown error reaches the caller as it would without the SDK.
 */
export function waitForQuickResponse<Answer>(
  answer: Promise<Answer>,
  limitMs: number,
): Promise<QuickResponse<Answer>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<QuickResponse<Answer>>((resolve) => {
    timeout = setTimeout(() => resolve({ answered: false }), limitMs);
  });
  const answered = answer.then((response): QuickResponse<Answer> => ({
    answered: true,
    response,
  }));
  return Promise.race([answered, limit]).finally(() => clearTimeout(timeout));
}

/**
 * The notification for the work's answer: a `2xx` with a JSON body is
 * `completed`, with the parsed body as its result. Anything else is
 * `failed`, without the body, which may hold the provider's internals.
 */
export function computeResultFromResponse(
  statusCode: number,
  body: string,
): Notification {
  if (statusCode < 200 || statusCode > 299) return { status: "failed" };
  try {
    return { status: "completed", result: JSON.parse(body) };
  } catch {
    return { status: "failed" };
  }
}

/** What Express-style work sent, once Varis was already answered. */
export interface CapturedResponse {
  statusCode: number;
  body: string;
}

export interface ExpressInterception {
  /** Resolves when the work ends the response itself. */
  ended: Promise<void>;
  /**
   * Answers `202 started` through the real response, then captures what
   * the work sends after that instead of writing it. Resolves with it when
   * the work ends the response.
   */
  answerStarted(): Promise<CapturedResponse>;
}

/**
 * Watches `res.end`, to see whether Express-style work answers in time.
 * Until `answerStarted`, the work's answer goes out untouched.
 *
 * After it, `setHeader`, `removeHeader`, and `writeHead` do nothing, and
 * `write` and `end` collect the body, because the real response has ended: without this,
 * the work's own `res.json` would throw `ERR_HTTP_HEADERS_SENT`.
 */
export function interceptExpressResponse(
  res: NodeResponse,
): ExpressInterception {
  const original = {
    setHeader: res.setHeader,
    writeHead: res.writeHead,
    write: res.write,
    end: res.end,
  };
  let resolveEnded!: () => void;
  const ended = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });

  res.end = (...args: unknown[]) => {
    res.end = original.end;
    resolveEnded();
    return original.end.apply(res, args);
  };

  return {
    ended,
    answerStarted: () => {
      const workStatusCode = res.statusCode;
      original.writeHead.call(res, 202, { "content-type": "application/json" });
      original.end.call(res, STARTED_BODY);
      // writeHead set it to 202. The work's answer keeps its own status.
      res.statusCode = workStatusCode;
      return captureResponse(res);
    },
  };
}

/** Replaces the writing methods of an ended `res` with ones that collect. */
function captureResponse(res: NodeResponse): Promise<CapturedResponse> {
  const chunks: Uint8Array[] = [];
  let statusCode: number | undefined;

  return new Promise((resolve) => {
    res.setHeader = () => res;
    // Express's res.send removes headers for a 204 or a 304.
    if (res.removeHeader) res.removeHeader = () => {};
    res.writeHead = (code: number) => {
      statusCode = code;
      return res;
    };
    res.write = (chunk: unknown, ...rest: unknown[]) => {
      collectChunk(chunks, chunk);
      callBack(rest);
      return true;
    };
    res.end = (...args: unknown[]) => {
      if (typeof args[0] !== "function") collectChunk(chunks, args[0]);
      callBack(args);
      resolve({
        statusCode: statusCode ?? res.statusCode,
        body: decoder.decode(joinChunks(chunks)),
      });
      return res;
    };
  });
}

function collectChunk(chunks: Uint8Array[], chunk: unknown): void {
  if (typeof chunk === "string") chunks.push(encoder.encode(chunk));
  else if (chunk instanceof Uint8Array) chunks.push(chunk);
}

/** Calls the callback that Node's `write` and `end` take last, as Node would. */
function callBack(args: unknown[]): void {
  const callback = args.at(-1);
  if (typeof callback === "function") queueMicrotask(() => callback());
}

function joinChunks(chunks: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(
    chunks.reduce((length, chunk) => length + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}
