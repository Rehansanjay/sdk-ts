/**
 * request-parts.ts: reads what verification and notifications need from
 * either request shape: a Web `Request` (Next.js, Hono, Bun, Deno, Workers)
 * or a Node.js `req` (Express, plain `node:http`).
 *
 * The Node shapes are structural, so this file needs no Node types and an
 * Express `req` and `res` are assignable to them.
 */

/** A Node.js `req`, as Express hands it to a route. */
export interface NodeRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly method?: string | undefined;
  readonly url?: string | undefined;
  /** Express keeps the full path here when a mounted router rewrites `url`. */
  readonly originalUrl?: string | undefined;
  /** What a body parser such as `express.json()` produced. */
  readonly body?: unknown;
  /** The body bytes, when a parser keeps them. */
  readonly rawBody?: unknown;
  /** Express sets this on every request. */
  readonly res?: NodeResponse | undefined;
}

/** A Node.js `res`, the parts the SDK reads and wraps. */
export interface NodeResponse {
  statusCode: number;
  readonly headersSent: boolean;
  readonly writableEnded: boolean;
  setHeader(name: string, value: any): unknown;
  removeHeader?(name: string): unknown;
  writeHead(statusCode: number, ...rest: any[]): unknown;
  write(chunk: any, ...rest: any[]): boolean;
  end(...args: any[]): unknown;
}

/** Any request the SDK accepts. */
export type VarisRequest = Request | NodeRequest;

/** The parts of a request that verification and notifications read. */
export interface RequestParts {
  /** Upper case, for example `POST`. */
  method: string;
  /** The path and query as received, still percent-encoded. No host. */
  pathAndQuery: string;
  /** A header's value, or null. `name` is case-insensitive. */
  header(name: string): string | null;
  /** The body bytes exactly as sent. Read only when needed. */
  readBody(): Promise<Uint8Array>;
}

const encoder = new TextEncoder();
const EMPTY = new Uint8Array(0);

export function isWebRequest(request: VarisRequest): request is Request {
  return typeof (request.headers as Headers).get === "function";
}

export function readRequestParts(request: VarisRequest): RequestParts {
  return isWebRequest(request)
    ? readWebRequestParts(request)
    : readNodeRequestParts(request);
}

function readWebRequestParts(request: Request): RequestParts {
  const url = new URL(request.url);
  return {
    method: request.method,
    pathAndQuery: `${url.pathname}${url.search}`,
    header: (name) => request.headers.get(name),
    readBody: async () => {
      if (request.bodyUsed) {
        throw new TypeError(
          "Call varis.requests.verify before reading the request body.",
        );
      }
      // Read a clone, so the caller can still read the original body.
      return new Uint8Array(await request.clone().arrayBuffer());
    },
  };
}

function readNodeRequestParts(request: NodeRequest): RequestParts {
  const method = (request.method ?? "GET").toUpperCase();
  return {
    method,
    pathAndQuery: request.originalUrl ?? request.url ?? "/",
    header: (name) => readNodeHeader(request, name),
    readBody: async () => method === "GET" ? EMPTY : readNodeBody(request),
  };
}

function readNodeHeader(request: NodeRequest, name: string): string | null {
  const value = request.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * The body bytes of a Node request, which a body parser has already read
 * from the stream. The gateway signs `JSON.stringify(input)`, and
 * `JSON.parse` keeps key order, so stringifying a parsed JSON body
 * reproduces the signed bytes.
 */
function readNodeBody(request: NodeRequest): Uint8Array {
  const raw = request.rawBody ?? request.body;
  if (raw instanceof Uint8Array) return raw;
  if (typeof raw === "string") return encoder.encode(raw);
  if (request.body !== undefined) {
    return encoder.encode(JSON.stringify(request.body));
  }
  throw new TypeError(
    "Varis can't read this request's body. Add a JSON body parser, such as " +
      "express.json(), before the route calls varis.requests.verify.",
  );
}
