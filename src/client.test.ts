import { describe, expect, test } from "bun:test";
import { DEFAULT_BASE_URL, StraylabsClient, StraylabsAbortError, StraylabsHttpError, StraylabsInputError, StraylabsOrganizationLookupError, StraylabsProtocolError, StraylabsTimeoutError } from "./index.js";
import type { BlackboxProjectInput, ProjectCreate, ProjectType, TestingAccountsConfig, TestingAccountsConfigOut } from "./index.js";
import { baseUrl, finding, mockFetch, organization, project, projectRoute, ref, scan, scanRef } from "../tests/fixtures.js";

function setup(handler: Parameters<typeof mockFetch>[0], options = {}) {
  const mock = mockFetch(handler);
  return { ...mock, client: new StraylabsClient({ baseUrl, apiKey: "test-key", fetch: mock.fetch, ...options }) };
}

test.each([{}, { baseUrl: undefined }])("uses the production API root when baseUrl is omitted or undefined", async options => {
  const { fetch, calls } = mockFetch(() => Response.json([organization]));
  const client = new StraylabsClient({ apiKey: "test-key", fetch, ...options });
  expect(DEFAULT_BASE_URL).toBe("https://platform.straylabs.ai/api");
  expect(await client.organizations.list()).toEqual([organization]);
  expect(calls[0]!.url).toBe("https://platform.straylabs.ai/api/me/organizations");
});

test("an explicit baseUrl overrides the production API root", async () => {
  const { client, calls } = setup(() => Response.json([organization]), { baseUrl: "https://custom.example/prefix/" });
  await client.organizations.list();
  expect(calls[0]!.url).toBe("https://custom.example/prefix/me/organizations");
});

describe("organization lookup by name", () => {
  test("selects an exact name from the API list and uses the returned ID in project requests", async () => {
    const target = { ...organization, future_field: "preserved" };
    const { client, calls } = setup(({ url }) => url.endsWith("/me/organizations")
      ? Response.json([{ ...organization, id: "another-id", name: "Another customer" }, target])
      : Response.json([]));
    const selected = await client.organizations.getByName("Customer");
    expect(selected).toEqual(target);
    await client.projects.list(selected.id);
    expect(calls.map(call => [call.init.method, call.url])).toEqual([
      ["GET", baseUrl + "/me/organizations"],
      ["GET", baseUrl + `/organizations/${organization.id}/projects`],
    ]);
  });
  test.each([{ organizations: [] }, { organizations: [{ ...organization, name: "customer" }] }])("unmatched and differently cased names report not_found", async ({ organizations }) => {
    const { client, calls } = setup(() => Response.json(organizations));
    try { await client.organizations.getByName("Customer"); throw new Error("Expected lookup failure"); }
    catch (error) {
      expect(error).toBeInstanceOf(StraylabsOrganizationLookupError);
      expect((error as StraylabsOrganizationLookupError).reason).toBe("not_found");
      expect((error as StraylabsOrganizationLookupError).organizationName).toBe("Customer");
    }
    expect(calls).toHaveLength(1);
  });
  test("duplicate names require selection by ID", async () => {
    const { client } = setup(() => Response.json([organization, { ...organization, id: "another-id" }]));
    try { await client.organizations.getByName("Customer"); throw new Error("Expected lookup failure"); }
    catch (error) {
      expect(error).toBeInstanceOf(StraylabsOrganizationLookupError);
      expect((error as StraylabsOrganizationLookupError).reason).toBe("ambiguous");
    }
  });
  test.each(["", " "])("invalid names fail before an API call", async name => {
    const { client, calls } = setup(() => Response.json([organization]));
    await expect(client.organizations.getByName(name)).rejects.toBeInstanceOf(StraylabsInputError);
    expect(calls).toHaveLength(0);
  });
  test("lookup honors request cancellation and timeout", async () => {
    const { client, calls } = setup(() => new Promise(() => {}));
    await expect(client.organizations.getByName("Customer", { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(StraylabsAbortError);
    expect(calls).toHaveLength(0);
    await expect(client.organizations.getByName("Customer", { timeoutMs: 10 })).rejects.toBeInstanceOf(StraylabsTimeoutError);
    expect(calls).toHaveLength(1);
  });
  test("API failures propagate without becoming organization lookup failures", async () => {
    const { client, calls } = setup(() => Response.json({ detail: "Forbidden" }, { status: 403 }));
    await expect(client.organizations.getByName("Customer")).rejects.toBeInstanceOf(StraylabsHttpError);
    expect(calls).toHaveLength(1);
  });
  test("lookup errors redact the configured credential", async () => {
    const { client } = setup(() => Response.json([]));
    try { await client.organizations.getByName("test-key"); throw new Error("Expected lookup failure"); }
    catch (error) { expect(error).toBeInstanceOf(StraylabsOrganizationLookupError); expect(JSON.stringify(error)).not.toContain("test-key"); }
  });
});

test("all v1 operations use the exact method/path/body, without discovery or filters", async () => {
  const payload = { project_name: "explicit", targets: ["raw-wire-target"], scope: "scope", type: "grey-box" as const };
  const responses: [string, string, unknown, number][] = [
    ["GET", "/me/organizations", [organization], 200],
    ["GET", `/organizations/${ref.organizationId}/projects`, [project()], 200],
    ["POST", `/organizations/${ref.organizationId}/projects`, project(), 201],
    ["GET", projectRoute, project(), 200],
    ["POST", `${projectRoute}/start-scan`, project({ current_scan_id: scanRef.scanId, scan_status: "running" }), 200],
    ["POST", `${projectRoute}/stop-scan`, project(), 200],
    ["GET", `${projectRoute}/scans`, [scan()], 200],
    ["GET", `${projectRoute}/scans/${scanRef.scanId}`, scan(), 200],
    ["GET", `${projectRoute}/findings`, [finding()], 200],
    ["POST", `${projectRoute}/reports/generate`, { project_id: ref.projectId, job_id: "job", status: "queued" }, 202],
    ["GET", `${projectRoute}/reports`, { reports: [] }, 200],
  ];
  let index = 0;
  const { client, calls } = setup(({ url, init }) => {
    const [method, route, body, status] = responses[index++]!;
    expect(url).toBe(baseUrl + route);
    expect(init.method).toBe(method);
    expect(init.redirect).toBe("error");
    expect(init.credentials).toBe("omit");
    const headers = new Headers(init.headers);
    expect(headers.get("x-api-key")).toBe("test-key");
    expect(headers.has("authorization")).toBe(false);
    if (index === 3) {
      expect(headers.get("content-type")).toBe("application/json");
      expect(JSON.parse(String(init.body))).toEqual(payload);
    } else {
      expect(init.body).toBeUndefined();
      expect(headers.has("content-type")).toBe(false);
    }
    return Response.json(body, { status });
  });
  expect(await client.organizations.list()).toEqual([organization]);
  expect(await client.projects.list(ref.organizationId)).toEqual([project()]);
  expect((await client.projects.create(ref.organizationId, payload)).id).toBe(ref.projectId);
  expect((await client.projects.get(ref)).current_scan_id).toBeNull();
  expect((await client.scans.start(ref)).current_scan_id).toBe(scanRef.scanId);
  await client.scans.stop(ref);
  await client.scans.list(ref);
  await client.scans.get(scanRef);
  expect(await client.findings.list(ref)).toEqual([finding()]);
  expect((await client.reports.generate(ref)).status).toBe("queued");
  expect(await client.reports.list(ref)).toEqual({ reports: [] });
  expect(calls).toHaveLength(responses.length);
});

test("base paths survive trailing slashes; identifiers are encoded independently", async () => {
  const { client, calls } = setup(() => Response.json(project()), { baseUrl: baseUrl + "///" });
  await client.projects.get({ organizationId: "org/with?query", projectId: "https://other.example/#x" });
  expect(calls[0]!.url).toBe(baseUrl + "/organizations/org%2Fwith%3Fquery/projects/https%3A%2F%2Fother.example%2F%23x");
});

describe("supported project creation types", () => {
  test.each(["black-box", "grey-box"] as const)("creates %s with the full testing-account policy", async type => {
    const testingAccounts = {
      accounts: [{ profile_name: "Supplied user", username: "tester@example.com", password: "fixture-password", role: "user", origin: "user", magic_link: null }],
      login_page: "https://app.customer.example/login", refresh_page: null,
      auth_policy: { allow_account_creation: true, max_accounts: 3, email_wait_timeout_s: 120, allow_resend: true, paste_timeout_s: 600 },
    } satisfies TestingAccountsConfig & TestingAccountsConfigOut;
    const body: ProjectCreate = {
      project_name: "Account-enabled test", targets: ["https://app.customer.example"], type,
      testing_accounts: testingAccounts,
    };
    const { client, calls } = setup(() => Response.json(project({ type, testing_accounts: testingAccounts }), { status: 201 }));
    const created = await client.projects.create(ref.organizationId, body);
    expect(created.type).toBe(type);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(body);
    expect(created.testing_accounts).toEqual(testingAccounts);
  });
  test("omitting type sends an explicit black-box type", async () => {
    const body = { project_name: "Default test", targets: ["https://app.customer.example"] };
    const { client, calls } = setup(() => Response.json(project(), { status: 201 }));
    await client.projects.create(ref.organizationId, body);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ ...body, type: "black-box" });
  });
  test("white-box is rejected by the public type and before HTTP dispatch", async () => {
    // @ts-expect-error White-box is outside the SDK's supported creation types.
    const unsupported: ProjectType = "white-box";
    const { client, calls } = setup(() => Response.json(project(), { status: 201 }));
    await expect(client.projects.create(ref.organizationId, {
      project_name: "Unsupported test", targets: ["https://app.customer.example"],
      // @ts-expect-error ProjectCreate also excludes white-box.
      type: "white-box",
    })).rejects.toBeInstanceOf(StraylabsInputError);
    expect(calls).toHaveLength(0);
  });
  test.each([null, "unknown"])("rejects invalid project types without HTTP", async type => {
    const { client, calls } = setup(() => Response.json(project(), { status: 201 }));
    await expect(client.projects.create(ref.organizationId, { project_name: "Invalid test", targets: ["https://app.customer.example"], type } as unknown as ProjectCreate)).rejects.toBeInstanceOf(StraylabsInputError);
    expect(calls).toHaveLength(0);
  });
  test("reading an existing white-box project preserves the API response", async () => {
    const existing = project({ type: "white-box" });
    const { client } = setup(() => Response.json(existing));
    expect(await client.projects.get(ref)).toEqual(existing);
  });
});

test.each(["", "/api", "https:deployment.example", "https:///deployment.example", "http://deployment.example", "ftp://localhost", "https://user:pass@deployment.example", "https://@deployment.example", "https://deployment.example?q=1", "https://deployment.example#", "https://deployment.example?", " https://deployment.example", "https:\\deployment.example"])("rejects unsafe base URL %s", url => {
  expect(() => new StraylabsClient({ baseUrl: url, apiKey: "key" })).toThrow(StraylabsInputError);
});

test.each(["http://localhost:8000/api", "http://127.0.0.1:8000", "http://[::1]:8000"])("allows explicit local development URL %s", url => {
  expect(() => new StraylabsClient({ baseUrl: url, apiKey: "opaque-prefix-is-okay" })).not.toThrow();
});

test.each(["", " ", "secret\nkey"])("rejects invalid API key", apiKey => {
  expect(() => new StraylabsClient({ baseUrl, apiKey })).toThrow(StraylabsInputError);
});

const blackbox: BlackboxProjectInput = {
  project_name: "request-123", targets: ["https://app.customer.example/path?a=1", "https://api.customer.example/v1?x=2"],
  scope: "Public application", exclusions: "Payments", environment: "staging",
};
test("createBlackbox sets exact forced configuration and preserves target order, paths and queries", async () => {
  const { client, calls } = setup(() => Response.json(project(), { status: 201 }));
  await client.projects.createBlackbox(ref.organizationId, blackbox);
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
    ...blackbox, certification_requirements: "iso27001", type: "black-box", architectural_resources: {},
    testing_accounts: { accounts: [], login_page: null, refresh_page: null, auth_policy: { allow_account_creation: false, max_accounts: 0 } },
  });
});

test.each(["type", "testing_accounts", "architectural_resources", "password", "contact", "external_reference"])("rejects blackbox override %s without HTTP", key => {
  const { client, calls } = setup(() => Response.json({}));
  expect(() => client.projects.createBlackbox(ref.organizationId, { ...blackbox, [key]: {} })).toThrow(StraylabsInputError);
  expect(calls).toHaveLength(0);
});

test.each([
  "http://public.example", "public.example", "https:///public.example", "https://user:pass@public.example", "https://@public.example",
  "https://localhost", "https://app.localhost.", "https://localhost.localdomain", "https://router.local", "https://127.1", "https://2130706433", "https://0x7f000001",
  "https://10.0.0.1", "https://100.64.0.1", "https://169.254.169.254", "https://172.16.0.1", "https://192.168.0.1",
  "https://192.0.2.1", "https://198.18.0.1", "https://198.51.100.1", "https://203.0.113.1", "https://224.0.0.1",
  "https://[::]", "https://[::1]", "https://[fe80::1]", "https://[fc00::1]", "https://[::ffff:127.0.0.1]", "https://[2001:db8::1]",
  "https://[2002:7f00:1::]", "https://[3fff::1]", "https://internal", "https://public.example\\@localhost", "https://public.example\n", " https://public.example",
])("rejects ambiguous/non-public target %s without HTTP", target => {
  const { client, calls } = setup(() => Response.json({}));
  expect(() => client.projects.createBlackbox(ref.organizationId, { ...blackbox, targets: [target] })).toThrow(StraylabsInputError);
  expect(calls).toHaveLength(0);
});

test.each(["https://8.8.8.8/path", "https://[2606:4700:4700::1111]/", "https://app.customer.example:8443/path?a=1"])("accepts public target syntax %s", async target => {
  const { client } = setup(() => Response.json(project(), { status: 201 }));
  await client.projects.createBlackbox(ref.organizationId, { ...blackbox, targets: [target] });
});

test.each([{ scope: " " }, { project_name: "" }, { targets: [] }, { environment: "unknown" }, { certification_requirements: "unknown" }])("rejects invalid blackbox values", overrides => {
  const { client, calls } = setup(() => Response.json({}));
  expect(() => client.projects.createBlackbox(ref.organizationId, { ...blackbox, ...overrides } as BlackboxProjectInput)).toThrow(StraylabsInputError);
  expect(calls).toHaveLength(0);
});

describe("scan history and latest details", () => {
  test("list returns every history entry without fetching individual details", async () => {
    const history = [scan(), scan({ id: "older", sequence_number: 0, status: "completed" })];
    const { client, calls } = setup(() => Response.json(history));
    expect(await client.scans.list(ref)).toEqual(history);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(baseUrl + projectRoute + "/scans");
  });
  test("get defaults to the latest scan and returns its complete details", async () => {
    const detail = {
      ...scan({
        status: "completed", ended_at: "2026-11-02T15:00:00+01:00",
        recon_run: { id: "recon-1", status: "completed", tasks_completed: 2, tasks_total: 2 },
        generation_task_count: 1,
        task_runs: [{ id: "task-row", task_id: "task-1", task_title: "Login test", run_id: "run-1", outcome: "confirmed_finding", ran_at: "2026-11-02T14:00:00+01:00", ended_at: "2026-11-02T14:01:00+01:00" }],
        findings: [{ id: "finding-1", task_id: "task-1", title: "Finding", severity_rating: "High", cvss_score: 8, confirmation_status: "review" }],
        summary: { new: 1, open: 1 },
      }),
      provider_extension: { preserved: true },
    };
    const history = [scan(), scan({ id: "older", sequence_number: 0 })];
    const { client, calls } = setup(({ url }) => Response.json(url.endsWith("/scans") ? history : detail));
    expect(await client.scans.get(ref)).toEqual(detail);
    expect(calls.map(call => call.url)).toEqual([
      baseUrl + projectRoute + "/scans",
      baseUrl + projectRoute + "/scans/" + scanRef.scanId,
    ]);
  });
  test("a project without scans returns null", async () => {
    const { client, calls } = setup(() => Response.json([]));
    expect(await client.scans.get(ref)).toBeNull();
    expect(calls).toHaveLength(1);
  });
  test("an invalid latest identity is a provider protocol error, not caller input failure", async () => {
    const { client, calls } = setup(() => Response.json([scan({ id: "" })]));
    await expect(client.scans.get(ref)).rejects.toBeInstanceOf(StraylabsProtocolError);
    expect(calls).toHaveLength(1);
  });
  test("history errors propagate without requesting details", async () => {
    const { client, calls } = setup(() => Response.json({ detail: "Forbidden" }, { status: 403 }));
    await expect(client.scans.get(ref)).rejects.toBeInstanceOf(StraylabsHttpError);
    expect(calls).toHaveLength(1);
  });
  test("a missing latest scan does not silently fall back to an older scan", async () => {
    const { client, calls } = setup(({ url }) => url.endsWith("/scans")
      ? Response.json([scan(), scan({ id: "older" })])
      : Response.json({ detail: "No longer available" }, { status: 404 }));
    await expect(client.scans.get(ref)).rejects.toBeInstanceOf(StraylabsHttpError);
    expect(calls).toHaveLength(2);
  });
  test("pre-cancelled latest lookups dispatch no requests", async () => {
    const { client, calls } = setup(() => Response.json([]));
    await expect(client.scans.get(ref, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(StraylabsAbortError);
    expect(calls).toHaveLength(0);
  });
  test("the latest lookup deadline covers detail retrieval and identifies the selected scan", async () => {
    const { client, calls } = setup(({ url }) => url.endsWith("/scans") ? Response.json([scan()]) : new Promise(() => {}));
    try { await client.scans.get(ref, { timeoutMs: 15 }); throw new Error("Expected timeout"); }
    catch (error) { expect(error).toBeInstanceOf(StraylabsTimeoutError); expect((error as StraylabsTimeoutError).ref).toEqual(scanRef); }
    expect(calls).toHaveLength(2);
  });
});

describe("single-request scan status", () => {
  test.each(["running", "completed", "failed", "abandoned", "future_status"])("returns progress and status %s without polling", async status => {
    const snapshot = scan({ status, progress_percent: 65 });
    const { client, calls } = setup(() => Response.json(snapshot));
    expect(await client.scans.get(scanRef)).toEqual(snapshot);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(baseUrl + projectRoute + "/scans/" + scanRef.scanId);
    expect(calls[0]!.init.method).toBe("GET");
  });
  test("reads the persisted scan after the project's current scan pointer disappears", async () => {
    const { client, calls } = setup(({ url }) => {
      if (url.endsWith("/start-scan")) return Response.json(project({ current_scan_id: scanRef.scanId, scan_status: "running" }));
      if (url.endsWith(projectRoute)) return Response.json(project());
      return Response.json(scan({ status: "completed" }));
    });
    const started = await client.scans.start(ref);
    expect(started.id).not.toBe(started.current_scan_id);
    expect((await client.projects.get(ref)).current_scan_id).toBeNull();
    const result = await client.scans.get({ ...ref, scanId: started.current_scan_id! });
    expect(result.status).toBe("completed");
    expect(calls.slice(2).map(call => call.url)).toEqual([baseUrl + projectRoute + "/scans/" + scanRef.scanId]);
  });
  test("100% with running status returns immediately and preserves null timestamps", async () => {
    const { client, calls } = setup(() => Response.json(scan()));
    const result = await client.scans.get(scanRef);
    expect(result.status).toBe("running");
    expect(result.progress_percent).toBe(100);
    expect(result.started_at).toBeNull();
    expect(result.ended_at).toBeNull();
    expect(calls).toHaveLength(1);
  });
  test("rejects missing status and mismatched scan identity", async () => {
    for (const body of [scan({ status: undefined }), scan({ id: "different" })]) {
      const { client, calls } = setup(() => Response.json(body));
      await expect(client.scans.get(scanRef)).rejects.toBeInstanceOf(StraylabsProtocolError);
      expect(calls).toHaveLength(1);
    }
  });
  test("request timeout retains the scan reference", async () => {
    const { client, calls } = setup(() => new Promise(() => {}));
    try { await client.scans.get(scanRef, { timeoutMs: 15 }); throw new Error("Expected timeout"); }
    catch (error) { expect(error).toBeInstanceOf(StraylabsTimeoutError); expect((error as StraylabsTimeoutError).ref).toEqual(scanRef); }
    expect(calls).toHaveLength(1);
  });
  test("cancelling a status request never invokes remote stop", async () => {
    const controller = new AbortController();
    const { client, calls } = setup(() => new Promise(() => {}));
    setTimeout(() => controller.abort(), 5);
    await expect(client.scans.get(scanRef, { signal: controller.signal })).rejects.toBeInstanceOf(StraylabsAbortError);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.method).toBe("GET");
  });
});

test("findings retain raw future states, all provenance, nulls, timestamps and additional fields", async () => {
  const raw = { ...finding({ severity_rating: "Future", confirmation_status: "new_status" }), future_property: { preserved: true } };
  const { client } = setup(() => Response.json([raw]));
  expect(await client.findings.list(ref)).toEqual([raw]);
});

test("no unsupported public resource operations are exposed", () => {
  const { client } = setup(() => Response.json({}));
  expect(Object.keys(client)).toEqual(["organizations", "projects", "scans", "findings", "reports"]);
  expect(Object.keys(client.projects)).toEqual(["list", "create", "createBlackbox", "get"]);
  expect(Object.keys(client.scans)).toEqual(["start", "stop", "list", "get"]);
  expect(Object.keys(client.findings)).toEqual(["list"]);
});

test.each(["../secret.pdf", "..", ".", "folder/file.pdf", "folder\\file.pdf", "", "file\n.pdf", "\ud800"])("rejects unsafe report filename %s before HTTP", async filename => {
  const { client, calls } = setup(() => Response.json({}));
  await expect(client.reports.download(ref, filename)).rejects.toBeInstanceOf(StraylabsInputError);
  expect(calls).toHaveLength(0);
});

test("report lists preserve empty inventory, Markdown-only entries and filename suffix ordering", async () => {
  for (const reports of [[], ["9", "2", "10"].map((suffix, index) => ({
    stem: `pentest_report_2026-11-02_${suffix}`, markdown_filename: `pentest_report_2026-11-02_${suffix}.md`,
    pdf_filename: index ? `pentest_report_2026-11-02_${suffix}.pdf` : null, created_at: "2026-11-02T14:30:00+00:00",
  }))]) {
    const { client } = setup(() => Response.json({ reports }));
    expect(await client.reports.list(ref)).toEqual({ reports });
  }
});

describe("latest available report download", () => {
  const reportFile = (suffix: string, createdAt = "2026-11-02T14:30:00+00:00", pdf = true) => ({
    stem: `pentest_report_2026-11-02_${suffix}`,
    markdown_filename: `pentest_report_2026-11-02_${suffix}.md`,
    pdf_filename: pdf ? `pentest_report_2026-11-02_${suffix}.pdf` : null,
    created_at: createdAt,
  });
  const bytes = new Uint8Array([37, 80, 68, 70, 45, 49, 0, 255]);

  test.each([{ reports: [] }, { reports: [reportFile("1", undefined, false)] }])("returns null when no PDF is available without generating or waiting", async inventory => {
    const { client, calls } = setup(() => Response.json(inventory));
    expect(await client.reports.download(ref)).toBeNull();
    expect(calls.map(call => [call.init.method, call.url])).toEqual([["GET", baseUrl + projectRoute + "/reports"]]);
  });
  test("selects the latest PDF by timestamp rather than list order or filename", async () => {
    const inventory = { reports: [reportFile("99", "2026-11-02T16:00:00+02:00"), reportFile("2", "2026-11-02T14:30:00Z")] };
    const { client, calls } = setup(({ url }) => url.endsWith("/reports")
      ? Response.json(inventory) : new Response(bytes, { headers: { "content-type": "application/pdf" } }));
    expect(await client.reports.download(ref)).toEqual({ filename: inventory.reports[1]!.pdf_filename!, contentType: "application/pdf", bytes });
    expect(calls.map(call => call.url)).toEqual([baseUrl + projectRoute + "/reports", baseUrl + projectRoute + "/reports/" + inventory.reports[1]!.pdf_filename]);
  });
  test("equal timestamps use numeric filename order and skip Markdown-only reports", async () => {
    const inventory = { reports: [reportFile("9"), reportFile("2"), reportFile("10"), reportFile("11", "2026-11-02T15:00:00Z", false)] };
    const { client, calls } = setup(({ url }) => url.endsWith("/reports")
      ? Response.json(inventory) : new Response(bytes, { headers: { "content-type": "application/pdf" } }));
    expect((await client.reports.download(ref))!.filename).toBe("pentest_report_2026-11-02_10.pdf");
    expect(calls).toHaveLength(2);
  });
  test("a PDF disappearing after listing returns null without falling back or generating", async () => {
    const { client, calls } = setup(({ url }) => url.endsWith("/reports")
      ? Response.json({ reports: [reportFile("2"), reportFile("1")] })
      : Response.json({ detail: "Missing file" }, { status: 404 }));
    expect(await client.reports.download(ref)).toBeNull();
    expect(calls).toHaveLength(2);
    expect(calls.every(call => call.init.method === "GET")).toBe(true);
  });
  test.each(["listing", "download"])("permission errors during %s remain errors", async stage => {
    const { client } = setup(({ url }) => stage === "download" && url.endsWith("/reports")
      ? Response.json({ reports: [reportFile("1")] }) : Response.json({ detail: "Forbidden" }, { status: 403 }));
    await expect(client.reports.download(ref)).rejects.toBeInstanceOf(StraylabsHttpError);
  });
  test("a missing project/list route is not treated as an empty inventory", async () => {
    const { client } = setup(() => Response.json({ detail: "Missing project" }, { status: 404 }));
    await expect(client.reports.download(ref)).rejects.toBeInstanceOf(StraylabsHttpError);
  });
  test.each([{ created_at: "not-a-date" }, { pdf_filename: "../secret.pdf" }])("malformed report metadata raises a protocol error before file download", async override => {
    const { client, calls } = setup(() => Response.json({ reports: [{ ...reportFile("1"), ...override }] }));
    await expect(client.reports.download(ref)).rejects.toBeInstanceOf(StraylabsProtocolError);
    expect(calls).toHaveLength(1);
  });
  test("latest download requires PDF bytes rather than Markdown", async () => {
    const { client } = setup(({ url }) => url.endsWith("/reports")
      ? Response.json({ reports: [reportFile("1")] })
      : new Response("# Markdown", { headers: { "content-type": "text/markdown" } }));
    await expect(client.reports.download(ref)).rejects.toBeInstanceOf(StraylabsProtocolError);
  });
  test("cancellation before lookup sends no request", async () => {
    const { client, calls } = setup(() => Response.json({ reports: [] }));
    await expect(client.reports.download(ref, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(StraylabsAbortError);
    expect(calls).toHaveLength(0);
  });
  test("the lookup deadline includes the file body read", async () => {
    const { client, calls } = setup(({ url }) => url.endsWith("/reports")
      ? Response.json({ reports: [reportFile("1")] })
      : new Response(new ReadableStream(), { headers: { "content-type": "application/pdf" } }));
    await expect(client.reports.download(ref, { timeoutMs: 15 })).rejects.toBeInstanceOf(StraylabsTimeoutError);
    expect(calls).toHaveLength(2);
  });
  test("generation queues after scan completion and download stays separate", async () => {
    let ready = false;
    const { client, calls } = setup(({ url }) => {
      if (url.endsWith("/scans/" + scanRef.scanId)) return Response.json(scan({ status: "completed" }));
      if (url.endsWith("/reports/generate")) return Response.json({ project_id: ref.projectId, job_id: "queued-job", status: "queued" }, { status: 202 });
      if (url.endsWith("/reports")) return Response.json({ reports: ready ? [reportFile("1")] : [] });
      return new Response(bytes, { headers: { "content-type": "application/pdf" } });
    });
    expect((await client.scans.get(scanRef)).status).toBe("completed");
    expect((await client.reports.generate(ref)).status).toBe("queued");
    expect(await client.reports.download(ref)).toBeNull();
    ready = true;
    expect((await client.reports.download(ref))!.bytes).toEqual(bytes);
    expect(calls.filter(call => call.init.method === "POST")).toHaveLength(1);
  });
});

test.each(["application/pdf", "text/markdown; charset=utf-8"])("downloads byte-exact %s, encoding the filename", async contentType => {
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x0d, 0x0a]);
  const filename = "report #1.pdf";
  const { client, calls } = setup(() => new Response(bytes, { headers: { "content-type": contentType } }));
  expect(await client.reports.download(ref, filename)).toEqual({ bytes, filename, contentType });
  expect(calls[0]!.url).toBe(baseUrl + projectRoute + "/reports/report%20%231.pdf");
});

test.each([
  ['attachment; filename="safe.pdf"', "safe.pdf"],
  ["attachment; filename*=UTF-8''rapport%20%C3%A9.pdf", "rapport é.pdf"],
  ['attachment; filename="../../secret.pdf"', "requested.pdf"],
  ["attachment; filename*=UTF-8''%ZZ", "requested.pdf"],
])("sanitizes attachment filename metadata", async (header, filename) => {
  const { client } = setup(() => new Response("pdf", { headers: { "content-type": "application/pdf", "content-disposition": header } }));
  expect((await client.reports.download(ref, "requested.pdf")).filename).toBe(filename);
});

test("missing report stays a 404; successful HTML is rejected as a protocol error", async () => {
  const { client, calls } = setup(() => new Response("Not found", { status: 404 }));
  await expect(client.reports.download(ref, "missing.pdf")).rejects.toBeInstanceOf(StraylabsHttpError);
  expect(calls).toHaveLength(1);
  const html = setup(() => new Response("<html>proxy error</html>", { headers: { "content-type": "text/html" } }));
  await expect(html.client.reports.download(ref, "bad.pdf")).rejects.toBeInstanceOf(StraylabsProtocolError);
});
