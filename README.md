# @straylabs/sdk

Server-side TypeScript SDK for Straylabs blackbox and greybox projects, scans, findings, and PDF/Markdown reports. Uses generated wire types from the pinned [OpenAPI export](./openapi.json), verified on 2026-11-02. The package name is the specification's proposed name; this repository does not establish publication or registry availability.

Requires Node.js 22+ or Bun 1.3+. Uses native `fetch`, with no runtime dependencies. ESM JavaScript and TypeScript declarations are built into `dist/`. Keep API credentials on the server.

## Install

Once published to your registry:

```sh
npm install @straylabs/sdk
# or
bun add @straylabs/sdk
```

For local evaluation, run `bun install`, `bun run build`, then `bun pm pack`. Install the resulting tarball in your server application.

## Create and start a blackbox project

The SDK defaults to `https://platform.straylabs.ai/api`. Supply your API key and resolve the intended organization by name with `client.organizations.getByName()`. Use `client.organizations.list()` to discover accessible organization names and IDs.

```ts
import { StraylabsClient } from "@straylabs/sdk";

const client = new StraylabsClient({
  apiKey: process.env.STRAYLABS_API_KEY!,
});

const organization = await client.organizations.getByName("Acme Corp");
const organizationId = organization.id;

// First record authorization, scope and a durable launch intent in your DB.
const project = await client.projects.createBlackbox(organizationId, {
  project_name: "customer-123-pentest-request-456", // deterministic, non-secret
  targets: ["https://app.customer.example", "https://api.customer.example"],
  scope: "Public application and API at the listed targets.",
  exclusions: "Payments and load testing.",
  environment: "staging",
});

const projectRef = { organizationId, projectId: project.id };
// Checkpoint project.id and pre-start scan IDs before dispatching start.
const before = await client.scans.list(projectRef);
const started = await client.scans.start(projectRef);
if (!started.current_scan_id) {
  throw new Error("Reconcile against the saved scan history before continuing.");
}
const scanRef = { ...projectRef, scanId: started.current_scan_id };
// Persist scanRef immediately: the project's current_scan_id later becomes null.
```

Creation and scan start are separate mutations. No POST is retried automatically. Persist each intent and successful checkpoint; a lost response requires reconciliation. The [tested workflow example](./examples/workflow.ts) demonstrates this with application-provided storage and locks.

Name lookup fetches `GET /me/organizations` and matches the exact, case-sensitive name. Missing or duplicate names throw `StraylabsOrganizationLookupError` with `reason: "not_found"` or `"ambiguous"`. For duplicate names, select the intended ID from `organizations.list()`.

`createBlackbox` requires explicit scope and absolute HTTPS targets. It preserves target order, paths and queries, rejects credentials/local hosts/non-public literal IPs, and forces blackbox settings with empty accounts, disabled account creation and empty architecture. This checks syntax only: the application must verify authorization, resolve DNS and enforce its public-destination policy.

## Blackbox and greybox configuration

`projects.create` supports `type: "black-box"` and `type: "grey-box"`, defaulting to `"black-box"` when omitted. White-box creation is excluded from the public input types and rejected locally with `StraylabsInputError`.

Both types accept the complete testing-account configuration through `projects.create`, including supplied credentials and permission for the agent to create accounts:

```ts
const project = await client.projects.create(organization.id, {
  project_name: "Authenticated application test",
  targets: ["https://app.customer.example"],
  scope: "Public signup and authenticated application flows.",
  type: "grey-box",
  testing_accounts: {
    accounts: [],
    login_page: "https://app.customer.example/login",
    refresh_page: null,
    auth_policy: {
      allow_account_creation: true,
      max_accounts: 3,
      email_wait_timeout_s: 120,
      allow_resend: true,
      paste_timeout_s: 600,
    },
  },
});
```

Supplied accounts support `profile_name`, `username`, `password`, `role`, `origin` and `magic_link`; use unique profile names. `allow_account_creation` is a permission policy: setting it does not invoke managed-account generation or prove that an account was created. The separate `POST /organizations/{org_id}/projects/{project_id}/testing-accounts/managed` endpoint generates a managed inbox/password identity for a profile. The supplied OpenAPI declares session/JWT authentication for that endpoint, so this API-key SDK does not call it. The strict `createBlackbox` helper always submits empty accounts and disables account creation; use `projects.create` to configure the policy explicitly.

## Scan history and progress

```ts
const scans = await client.scans.list(projectRef); // all scans, newest first
const latest = await client.scans.get(projectRef); // latest scan's full details, or null

if (latest) {
  console.log({
    progress: latest.progress_percent,
    status: latest.status,
    failed: latest.status === "failed",
  });
}

// Supply a scan ID to fetch that specific execution's full details.
const scan = await client.scans.get(scanRef);
```

`scans.get(projectRef)` defaults to the latest scan and returns its complete API response: progress, status, phases, timestamps, recon information, task runs, findings and summary. It looks up the newest history entry, then fetches its details. Supplying `scanId` skips that lookup and sends one detail request. An empty history returns `null`; a failed lookup or missing detail response raises an error without silently selecting an older scan. The request timeout covers both lookup and detail retrieval.

The SDK returns the current state without polling; the application decides when to refresh again. Status is `running`, `completed`, `failed`, or `abandoned`; future values are preserved for the caller to handle. A running scan at 100% is still running. To stop the project's current remote scan, explicitly call `client.scans.stop(projectRef)` after checking the stored scan is still current. Normal stop abandons a scan; there is no v1 resume method.

## Findings and reports

```ts
const findings = await client.findings.list(projectRef);
const scanFindingIds = new Set(scan.findings?.map(finding => finding.id));
const currentScanFindings = findings.filter(finding => scanFindingIds.has(finding.id));

// Enqueue once after the intended scan completes; persist the intent first.
const queued = await client.reports.generate(projectRef); // 202: queued
// Checkpoint queued.job_id. Download/refresh does not enqueue another job.
```

Generation is asynchronous: queuing a job does not make its report immediately available. Download is a separate call that returns the latest available PDF or `null`:

```ts
const report = await client.reports.download(projectRef, {
  timeoutMs: 120_000,
});
if (report) {
  // { filename, contentType, bytes: Uint8Array }
  // Verify PDF content, hash exact bytes, and store evidence idempotently.
}
```

The default download lists reports, skips entries without a PDF, then downloads the newest available PDF by `created_at`. Equal timestamps use numeric filename ordering, so suffix `_10` follows `_9`. No PDF ready, an empty inventory, or a selected file disappearing before download returns `null`. Permission, network and server errors still raise typed errors. Listing and downloading share one timeout and cancellation budget; download never generates or polls for a report.

For a specific PDF or Markdown file, use `client.reports.download(projectRef, filename, options)`. An explicitly requested missing file remains a 404 error. The latest available PDF may belong to an earlier scan while a newer generation job is pending; reports expose no scan/job attribution metadata. For scan-specific evidence, use the [report attribution guide](https://github.com/straylabs-ai/deadend-docs/blob/main/deadend-docs/content/docs/SDK/reports.mdx) and pass the selected filename explicitly.

Findings retain snake_case fields, original IDs, nullable timestamps and provider strings. The project findings store and scan association can change over time. A `resolved` status alone does not establish a verified fix; missing findings never imply resolution. See the [integration guide](https://github.com/straylabs-ai/deadend-docs/blob/main/deadend-docs/content/docs/SDK/errors.mdx) for evidence joins, triage and recovery.

## Configuration and errors

| Option | Default | Meaning |
| --- | --- | --- |
| `baseUrl` | `https://platform.straylabs.ai/api` | Optional override; absolute API root including deployment prefix, HTTPS except loopback development |
| `apiKey` | Required | Opaque non-empty API key, sent only as `x-api-key` |
| `fetch` | Native fetch | Injectable server fetch honoring `redirect: "error"` |
| `timeoutMs` | `30_000` | Whole request, retries, delays and body read |
| `maxReadRetries` | `2` | Additional GET attempts; POST always sends once |

Override the API root for another deployment with `new StraylabsClient({ apiKey, baseUrl: "https://deployment.example/api" })`. The default is also exported as `DEFAULT_BASE_URL`.

Each operation accepts `{ signal?, timeoutMs? }`. Positive timeouts must not exceed 2,147,483,647 ms. URLs retain `/api` prefixes, path segments are encoded independently, and authenticated redirects are rejected.

GET retries cover network failures and HTTP 429/502/503/504. Backoff uses jitter, with a one-second initial exponential component capped at 30 seconds. A valid `Retry-After` is a minimum delay. A retry that cannot fit the deadline raises `StraylabsTimeoutError`. Auth errors, malformed successes, cancellation and POST are never retried.

```ts
import { StraylabsHttpError, StraylabsTransportError } from "@straylabs/sdk";

try {
  await client.scans.start(projectRef);
} catch (error) {
  if (error instanceof StraylabsHttpError) {
    // status, detail/body, method, route, ref, correlationId, retryAfterMs
    // 401: credential; 403: terms/permission/tier; 409: reconcile scan controls.
  }
  if (error instanceof StraylabsTransportError && error.outcomeUnknown) {
    // Read persisted history to reconcile; do not repeat the mutation blindly.
  }
  throw error;
}
```

Also exported: `StraylabsInputError`, `StraylabsProtocolError`, `StraylabsTimeoutError`, `StraylabsAbortError`, and their base `StraylabsError`. Timeout, abort and protocol errors also carry `outcomeUnknown` when a dispatched mutation lacks a reliable outcome. Error details can be strings or structured validation arrays. The SDK performs no logging and redacts credentials from error context. Store errors according to your application's data policy.

## Documentation

- [API reference](https://github.com/straylabs-ai/deadend-docs/blob/main/deadend-docs/content/docs/SDK/reference.mdx): every method, return type, endpoint and error.
- [Integration guide](https://github.com/straylabs-ai/deadend-docs/blob/main/deadend-docs/content/docs/SDK/getting_started.mdx): durable launch, bounded sync, findings and report evidence.
- [SDK capabilities](https://github.com/straylabs-ai/deadend-docs/blob/main/deadend-docs/content/docs/SDK/reference.mdx): supported methods and current API-key boundaries.
- [SDK overview](https://github.com/straylabs-ai/deadend-docs/blob/main/deadend-docs/content/docs/SDK/index.mdx).

Sub-account provisioning, outbound webhooks, dedicated finding retests, guaranteed report-to-scan attribution and automatic verified-remediation decisions are unavailable in this v1 contract.

## Development

```sh
bun install --frozen-lockfile
bun run generate:check
bun run typecheck
bun test
bun run build
bun tests/runtime-smoke.mjs
node tests/runtime-smoke.mjs
bun pm pack --dry-run
```

Tests use mocked HTTP fixtures and never launch real scans. Workflow tests exercise the reference adapter with test storage; validate actual database locking, Nhost evidence delivery and operational policy in the consuming integration. Runtime smoke checks exercise built ESM with native Node/Bun fetch. CI covers Node 22/24 and Bun.

To refresh the contract, replace `openapi.json` with a reviewed export, update [openapi.metadata.json](./openapi.metadata.json), run `bun run generate`, and review generated types, response validators, explicit report overrides, tests and docs together. The generator emits all 99 component wire types; the package exports the types relevant to v1. Production builds never fetch an OpenAPI route. API document version `0.1.0` alone is not a compatibility guarantee.

The publish workflow runs checks before publishing on a release, `v*` tag or manual dispatch. Configure `NPM_TOKEN` with publish access to `@straylabs`; changing code locally does not publish a package.

## License

[Apache License 2.0](./LICENSE)
