# @usevaris/sdk

Declare Varis services in TypeScript. The SDK turns your types into the JSON
Schemas in `varis.json`, which the Varis CLI publishes. It also verifies that
requests to your endpoints come from Varis, and reports on calls that take
longer than Varis's 30-second limit for a first answer.

## Install

```bash
npm install @usevaris/sdk
```

## Example

```ts
import { Varis } from "@usevaris/sdk";

type Input = { city: string };
type Output = { max_temp: number; min_temp: number };

const varis = new Varis();

varis.services.define<Input, Output>({
  slug: "weather",
  name: "Weather",
  description: "Returns the temperature range for any city.",
  service_type: "data",
  categories: ["science"],
  path: "/weather",
  price_cents: 3,
});
```

`path` is joined to the production `base_url` in `varis.json`. Use
`endpoint_url` instead for a service on another host. `method`, `price_cents`,
`version`, and `status` are optional.

Then run `varis build` from the project root to update `varis.json`.

## Verify requests

In the handler that serves the service, reject any request Varis didn't sign
before you read the body:

```ts
if (!(await varis.requests.verify(request))) {
  return new Response("Unauthorized", { status: 401 });
}
```

`requests.verify` takes a Web `Request` or a Node.js `req`, such as
Express's. For a Node.js `req`, register a JSON body parser such as
`express.json()` first.

`verifyRequest` is deprecated. It calls `requests.verify`, logs a warning
once, and is removed in 2.0.0.

## Long calls

Varis waits 30 seconds for a first answer. For work that can take longer,
wrap it in one of these, after the `requests.verify` check:

```ts
// The work runs in the route. Answers Varis 202 at 20 seconds if needed,
// then sends the result when it's ready.
return varis.requests.handleOnServer(request, renderVideo(request));

// The work runs in a queue worker. In the route:
await queue.add("render", {
  input: req.body,
  varis: await varis.requests.delegateToWorker(req), // null for normal users
});
// In the worker:
await varis.requests.handleInWorker(job.data.varis, () => render(job.data.input));
```

Requests that aren't from Varis pass through untouched. On serverless
platforms other than Next.js, pass the platform's `waitUntil` to
`new Varis({ waitUntil })`. Keep results under 4 MB of JSON.

## Documentation

See the [Varis documentation](TODO) for setup, every field, supported types, and
publishing.

## License

MIT
