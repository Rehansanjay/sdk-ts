/**
 * requests.ts: `varis.requests`, the calls a provider drops into an
 * existing route.
 *
 * Each call works on its own and is one line in the route. None wraps a
 * whole route or assumes the route exists only for Varis: the route keeps
 * serving its own users, and calls that aren't from Varis pass through
 * untouched.
 */
import { readRequestParts, type VarisRequest } from "./request-parts.js";
import { RequestVerifier, type VarisOptions } from "./verify.js";

/** What the SDK remembers about one request. */
interface RequestRecord {
  /** What `verify` answered, shared by every later call. */
  isVaris?: Promise<boolean>;
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

export class Requests {
  readonly #verifier: RequestVerifier;
  readonly #records = new WeakMap<object, RequestRecord>();

  constructor(options: VarisOptions) {
    this.#verifier = new RequestVerifier(options);
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
}
