import type { VarisRequest } from "./request-parts.js";
import { Requests } from "./requests.js";
import type { ServiceDefinition } from "./types.js";
import type { VarisOptions } from "./verify.js";

export type {
  NodeRequest,
  NodeResponse,
  VarisRequest,
} from "./request-parts.js";
export type {
  ServiceCategory,
  ServiceDefinition,
  ServiceMethod,
  ServiceStatus,
  ServiceType,
} from "./types.js";
export {
  VarisKeyFetchError,
  type VarisOptions,
  type VarisPublicKey,
} from "./verify.js";

class Services {
  /**
   * Declares a Varis service. Does nothing at runtime.
   *
   * `varis build` reads this call from your source code. `Input` and `Output`
   * become the service's input and output JSON Schemas. Every value you pass
   * must be a literal, not a variable or environment value.
   */
  define<Input, Output>(definition: ServiceDefinition): void {
    void definition;
  }
}

/** Set once the deprecation warning for `verifyRequest` has been logged. */
let warnedAboutVerifyRequest = false;

export class Varis {
  readonly services = new Services();
  readonly requests: Requests;

  /** `options` configures the SDK. Varis never needs a credential. */
  constructor(options: VarisOptions = {}) {
    this.requests = new Requests(options);
  }

  /**
   * @deprecated Use `varis.requests.verify`, which takes the same request.
   * Will be removed in January 2027.
   */
  verifyRequest(request: VarisRequest): Promise<boolean> {
    if (!warnedAboutVerifyRequest) {
      warnedAboutVerifyRequest = true;
      console.warn(
        "Varis: verifyRequest is deprecated and will be removed in January 2027. " +
          "Use varis.requests.verify instead.",
      );
    }
    return this.requests.verify(request);
  }
}
