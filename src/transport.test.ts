import { describe, expect, test } from "bun:test";
import { inspect } from "node:util";
import { StraylabsClient, StraylabsAbortError, StraylabsHttpError, StraylabsInputError, StraylabsProtocolError, StraylabsTimeoutError, StraylabsTransportError } from "./index.js";
import { baseUrl, mockFetch, project, ref, scan, scanRef } from "../tests/fixtures.js";

function setup(handler: Parameters<typeof mockFetch>[0], options = {}) {
  const mock = mockFetch(handler);
  return { ...mock, client: new StraylabsClient({ baseUrl, apiKey: "test-secret", fetch: mock.fetch, ...options }) };
}
async function caught(operation: Promise<unknown>): Promise<any> {
  try { await operation; throw new Error("Expected failure"); } catch (error) { return error; }
}

describe("HTTP errors", () => {
  test.each([400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504])("preserves status %i and context", async status => {
    const { client, calls } = setup(() => Response.json({ detail: "Readable explanation" }, {
      status, headers: { "x-request-id": "request-123", "retry-after": "60" },
    }), { maxReadRetries: 0 });
    const error = await caught(client.projects.get(ref));
    expect(error).toBeInstanceOf(StraylabsHttpError);
    expect(error.status).toBe(status);
    expect(error.message).toBe("Readable explanation");
    expect(error.detail).toBe("Readable explanation");
    expect(error.correlationId).toBe("request-123");
    expect(error.retryAfterMs).toBe(60_000);
    expect(error.method).toBe("GET");
    expect(error.ref).toEqual(ref);
    expect(calls).toHaveLength(1);
  });
  test("preserves structured validation arrays and plain text proxy bodies", async () => {
    const detail = [{ loc: ["body", "targets"], msg: "Field required", type: "missing" }];
    const json = setup(() => Response.json({ detail }, { status: 422 }));
    expect((await caught(json.client.projects.get(ref))).detail).toEqual(detail);
    const proxy = setup(() => new Response("upstream unavailable", { status: 502 }), { maxReadRetries: 0 });
    expect((await caught(proxy.client.projects.get(ref))).body).toBe("upstream unavailable");
  });
  test("supports Retry-After HTTP dates and ignores malformed values", async () => {
    const target = new Date(Date.now() + 60_000).toUTCString();
    const { client } = setup(() => Response.json({ detail: "limited" }, { status: 429, headers: { "Retry-After": target } }), { maxReadRetries: 0 });
    const error = await caught(client.organizations.list());
    expect(error.retryAfterMs).toBeGreaterThan(58_000);
    expect(error.retryAfterMs).toBeLessThanOrEqual(60_000);
    for (const value of ["-10", "NaN", "not a date", "Infinity"]) {
      const mock = setup(() => Response.json({}, { status: 429, headers: { "retry-after": value } }), { maxReadRetries: 0 });
      expect((await caught(mock.client.organizations.list())).retryAfterMs).toBeUndefined();
    }
  });
  test("a broken error body preserves auth status and never triggers a read retry", async () => {
    const { client, calls } = setup(() => new Response(new ReadableStream({ start(controller) { controller.error(new Error("dropped body")); } }), { status: 401 }));
    const error = await caught(client.organizations.list());
    expect(error).toBeInstanceOf(StraylabsHttpError);
    expect(error.status).toBe(401); expect(calls).toHaveLength(1);
  });
  test("a broken rate-limit body retains Retry-After rather than retrying too early", async () => {
    const { client, calls } = setup(() => new Response(new ReadableStream({ start(controller) { controller.error(new Error("dropped body")); } }), { status: 429, headers: { "retry-after": "60" } }));
    expect(await caught(client.organizations.list({ timeoutMs: 100 }))).toBeInstanceOf(StraylabsTimeoutError);
    expect(calls).toHaveLength(1);
  });
});

describe("retry policy", () => {
  test("default GET retry budget allows two additional attempts for network failures", async () => {
    const { client, calls } = setup(() => { throw new Error("network failure"); });
    expect(await caught(client.organizations.list())).toBeInstanceOf(StraylabsTransportError);
    expect(calls).toHaveLength(3);
  });
  test("transient GET failures can recover within the same deadline", async () => {
    let attempts = 0;
    const { client, calls } = setup(() => ++attempts < 2 ? Response.json({}, { status: 503 }) : Response.json(project()));
    expect((await client.projects.get(ref)).id).toBe(ref.projectId);
    expect(calls).toHaveLength(2);
  });
  test.each([400, 401, 403, 404, 409, 422, 500])("GET does not retry non-transient HTTP %i", async status => {
    const { client, calls } = setup(() => Response.json({}, { status }));
    expect(await caught(client.organizations.list())).toBeInstanceOf(StraylabsHttpError);
    expect(calls).toHaveLength(1);
  });
  test.each([429, 502, 503, 504])("transient HTTP %i honors retry delay and the operation deadline", async status => {
    const { client, calls } = setup(() => Response.json({}, { status, headers: { "retry-after": "60" } }));
    expect(await caught(client.organizations.list({ timeoutMs: 20 }))).toBeInstanceOf(StraylabsTimeoutError);
    expect(calls).toHaveLength(1);
  });
  test.each([429, 500, 502, 503, 504])("mutations never retry HTTP %i", async status => {
    const { client, calls } = setup(() => Response.json({}, { status }));
    const error = await caught(client.scans.start(ref));
    expect(error).toBeInstanceOf(StraylabsHttpError);
    expect(error.outcomeUnknown).toBe(status >= 500);
    expect(calls).toHaveLength(1);
  });
  test("a lost mutation response is dispatched once and reports outcome uncertainty", async () => {
    const { client, calls } = setup(() => { throw new Error("connection closed after dispatch"); });
    const error = await caught(client.scans.start(ref));
    expect(error).toBeInstanceOf(StraylabsTransportError);
    expect(error.outcomeUnknown).toBe(true);
    expect(error.cause.message).toBe("connection closed after dispatch");
    expect(calls).toHaveLength(1);
  });
});

describe("deadlines and cancellation", () => {
  test.each(["GET", "POST"])("%s timeout includes response body consumption", async method => {
    const body = new ReadableStream<Uint8Array>({ start() { /* Deliberately stalls. */ } });
    const { client, calls } = setup(() => new Response(body));
    const error = await caught(method === "GET" ? client.projects.get(ref, { timeoutMs: 10 }) : client.scans.start(ref, { timeoutMs: 10 }));
    expect(error).toBeInstanceOf(StraylabsTimeoutError);
    expect(error.outcomeUnknown).toBe(method === "POST");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.signal!.aborted).toBe(true);
  });
  test("download timeout includes binary body consumption", async () => {
    const { client } = setup(() => new Response(new ReadableStream(), { headers: { "content-type": "application/pdf" } }));
    expect(await caught(client.reports.download(ref, "file.pdf", { timeoutMs: 10 }))).toBeInstanceOf(StraylabsTimeoutError);
  });
  test("pre-aborted mutations dispatch nothing and have no outcome uncertainty", async () => {
    const controller = new AbortController(); controller.abort(new Error("secret abort reason"));
    const { client, calls } = setup(() => Response.json(project()));
    const error = await caught(client.scans.start(ref, { signal: controller.signal }));
    expect(error).toBeInstanceOf(StraylabsAbortError);
    expect(error.outcomeUnknown).toBe(false);
    expect(calls).toHaveLength(0);
  });
  test("cancels stalled fetch even if the injected fetch ignores AbortSignal", async () => {
    const controller = new AbortController();
    const { client, calls } = setup(() => new Promise(() => {}));
    setTimeout(() => controller.abort(), 5);
    const error = await caught(client.scans.stop(ref, { signal: controller.signal }));
    expect(error).toBeInstanceOf(StraylabsAbortError);
    expect(error.outcomeUnknown).toBe(true);
    expect(calls).toHaveLength(1);
  });
  test("cancellation interrupts retry sleep without another request", async () => {
    const controller = new AbortController();
    const { client, calls } = setup(() => { setTimeout(() => controller.abort(), 5); throw new Error("network error"); });
    expect(await caught(client.organizations.list({ signal: controller.signal }))).toBeInstanceOf(StraylabsAbortError);
    expect(calls).toHaveLength(1);
  });
  test("GET response stream failure can retry", async () => {
    let attempts = 0;
    const { client, calls } = setup(() => ++attempts === 1
      ? new Response(new ReadableStream({ start(controller) { controller.error(new Error("socket closed")); } }))
      : Response.json(project()));
    expect((await client.projects.get(ref)).id).toBe(ref.projectId);
    expect(calls).toHaveLength(2);
  });
});

test.each([new Response("bad json"), Response.json({}), Response.json({ id: "only-id" }), Response.json([])])("malformed success never retries or fabricates required fields", async response => {
  const { client, calls } = setup(() => response);
  expect(await caught(client.projects.get(ref))).toBeInstanceOf(StraylabsProtocolError);
  expect(calls).toHaveLength(1);
});

test("malformed mutation response retains uncertainty", async () => {
  const { client, calls } = setup(() => Response.json({}));
  const error = await caught(client.scans.start(ref));
  expect(error).toBeInstanceOf(StraylabsProtocolError);
  expect(error.outcomeUnknown).toBe(true);
  expect(calls).toHaveLength(1);
});

test("report overrides reject generic objects, invalid queued responses and malformed list entries", async () => {
  for (const body of [{}, { project_id: ref.projectId, job_id: "", status: "queued" }, { project_id: ref.projectId, job_id: "job", status: "done" }]) {
    const { client } = setup(() => Response.json(body, { status: 202 }));
    expect(await caught(client.reports.generate(ref))).toBeInstanceOf(StraylabsProtocolError);
  }
  for (const body of [{}, [], { reports: [{}] }, { reports: [{ stem: "x", markdown_filename: "x.md", pdf_filename: 123, created_at: "now" }] }]) {
    const { client } = setup(() => Response.json(body));
    expect(await caught(client.reports.list(ref))).toBeInstanceOf(StraylabsProtocolError);
  }
});

test("known additionalProperties value types are checked without rejecting new response fields", async () => {
  const { client } = setup(() => Response.json({ ...scan(), future_field: true, summary: { by_severity: { Critical: "bad" } } }));
  expect(await caught(client.scans.get(scanRef))).toBeInstanceOf(StraylabsProtocolError);
  const valid = { ...scan(), future_field: true, summary: { by_severity: { FutureSeverity: 2 } } };
  const future = setup(() => Response.json(valid));
  expect(await future.client.scans.get(scanRef)).toEqual(valid);
});

test("redacts keys from HTTP bodies, messages, correlation headers, and transport causes", async () => {
  const key = "test-secret";
  const { client } = setup(() => Response.json({ detail: `invalid ${key}`, api_key: key, nested: { password: "sensitive" } }, { status: 401, headers: { "x-request-id": key } }));
  const http = await caught(client.projects.get(ref));
  expect(inspect(http, { depth: 10 })).not.toContain(key);
  expect(JSON.stringify(http)).not.toContain("sensitive");
  const network = setup(() => { throw new Error(`fetch failed with ${key}`); }, { maxReadRetries: 0 });
  expect(inspect(await caught(network.client.projects.get(ref)), { depth: 10 })).not.toContain(key);
  expect(inspect(client, { depth: 10 })).not.toContain(key);
});

test.each([0, -1, NaN, Infinity, 2_147_483_648])("invalid timeout %s sends no HTTP", async timeoutMs => {
  const { client, calls } = setup(() => Response.json(project()));
  expect(() => new StraylabsClient({ baseUrl, apiKey: "x", timeoutMs })).toThrow(StraylabsInputError);
  await expect(client.projects.get(ref, { timeoutMs })).rejects.toBeInstanceOf(StraylabsInputError);
  expect(calls).toHaveLength(0);
});

test.each([-1, 1.5, NaN, Infinity])("invalid maxReadRetries sends no HTTP", maxReadRetries => {
  expect(() => new StraylabsClient({ baseUrl, apiKey: "x", maxReadRetries })).toThrow(StraylabsInputError);
});

test("circular request body fails locally with typed input error", async () => {
  const { client, calls } = setup(() => Response.json(project()));
  const body: any = { project_name: "x", targets: ["x"] }; body.extra = body;
  expect(await caught(client.projects.create(ref.organizationId, body))).toBeInstanceOf(StraylabsInputError);
  expect(calls).toHaveLength(0);
});
