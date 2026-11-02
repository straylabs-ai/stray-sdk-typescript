import { expect, test } from "bun:test";
import { StraylabsClient, StraylabsTransportError } from "../src/index.js";
import type { FindingOut, ReportDownload, ReportFile, ScanTaskRunOut } from "../src/index.js";
import { baseUrl, finding, mockFetch, project, projectRoute, ref, scan, scanRef } from "../tests/fixtures.js";
import { launch, ReconciliationRequired, synchronize, verificationEvidence } from "./workflow.js";
import type { LaunchInput, WorkflowRecord, WorkflowStore } from "./workflow.js";

// Test fixture only. Production uses a DB transaction/advisory lock and durable
// reservation. Returning copies simulates process restarts between every pass.
class MemoryStore implements WorkflowStore {
  records = new Map<string, WorkflowRecord>();
  rows = new Map<string, { provider: FindingOut; triage: string; assignee: string }>();
  evidence = new Map<string, string>();
  failAfterUpload = false;
  #locks = new Map<string, Promise<void>>();
  async withOrganization<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.#locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>(resolve => { release = resolve; });
    this.#locks.set(id, prior.then(() => next));
    await prior;
    try { return await operation(); } finally { release(); }
  }
  async load(id: string) { return structuredClone(this.records.get(id)); }
  async save(record: WorkflowRecord) {
    const conflicting = [...this.records.values()].some(other => other.requestId !== record.requestId
      && other.applicationOrganizationId === record.applicationOrganizationId
      && !["completed", "failed", "cancelled"].includes(other.stage));
    if (conflicting) throw new ReconciliationRequired("An organization already has a reserved pentest.");
    this.records.set(record.requestId, structuredClone(record));
  }
  async upsertProviderFindings(record: WorkflowRecord, findings: FindingOut[]) {
    for (const provider of findings) {
      const key = `${record.applicationOrganizationId}:straylabs:${provider.id}`;
      const previous = this.rows.get(key);
      this.rows.set(key, { triage: "needs_review", assignee: "analyst", ...previous, provider: structuredClone(provider) });
    }
  }
  async commitDelivery(record: WorkflowRecord, report: ReportDownload, sha256: string) {
    const key = `${record.applicationOrganizationId}:${record.requestId}:${report.filename}:${sha256}`;
    const evidenceId = this.evidence.get(key) ?? `evidence-${this.evidence.size + 1}`;
    this.evidence.set(key, evidenceId);
    if (this.failAfterUpload) { this.failAfterUpload = false; throw new Error("Crash after upload"); }
    await this.save({ ...record, evidenceId, stage: "completed" });
  }
}

const input: LaunchInput = {
  requestId: "request-123", applicationOrganizationId: "app-org", organizationId: ref.organizationId,
  input: { project_name: "request-123", targets: ["https://app.customer.example/path?a=1"], scope: "Public application" },
};
const report = (suffix: string, pdf = true): ReportFile => ({
  stem: `pentest_report_2026-11-02_${suffix}`, markdown_filename: `pentest_report_2026-11-02_${suffix}.md`,
  pdf_filename: pdf ? `pentest_report_2026-11-02_${suffix}.pdf` : null, created_at: "2026-11-02T14:30:00+00:00",
});
function setup() {
  const store = new MemoryStore();
  const state = {
    projectCreated: false, scanStarted: false, completed: false,
    loseCreate: false, loseStart: false, loseGenerate: false,
    creates: 0, starts: 0, generates: 0, downloads: 0,
    reports: [] as ReportFile[], findings: [finding()],
  };
  const mock = mockFetch(({ url, init }) => {
    const route = url.slice(baseUrl.length);
    if (init.method === "POST" && route.endsWith("/projects")) {
      state.creates++; state.projectCreated = true;
      if (state.loseCreate) { state.loseCreate = false; throw new Error("Create response lost"); }
      return Response.json(project(), { status: 201 });
    }
    if (init.method === "GET" && route.endsWith("/projects")) return Response.json(state.projectCreated ? [project()] : []);
    if (route.endsWith("/start-scan")) {
      state.starts++; state.scanStarted = true;
      if (state.loseStart) { state.loseStart = false; throw new Error("Start response lost"); }
      return Response.json(project({ current_scan_id: scanRef.scanId }));
    }
    if (route === projectRoute) return Response.json(project({ current_scan_id: state.completed ? null : scanRef.scanId }));
    if (route.endsWith("/scans")) return Response.json(state.scanStarted ? [scan({ status: state.completed ? "completed" : "running" })] : []);
    if (route.endsWith(`/scans/${scanRef.scanId}`)) return Response.json(scan({ status: state.completed ? "completed" : "running" }));
    if (route.endsWith("/findings")) return Response.json(state.findings);
    if (route.endsWith("/reports/generate")) {
      state.generates++;
      if (state.loseGenerate) { state.loseGenerate = false; throw new Error("Generate response lost"); }
      return Response.json({ project_id: ref.projectId, job_id: "job-1", status: "queued" }, { status: 202 });
    }
    if (route.endsWith("/reports")) return Response.json({ reports: state.reports });
    if (route.includes("/reports/")) {
      state.downloads++;
      return new Response("%PDF-1.7\nExact fixture bytes\n", { headers: { "content-type": "application/pdf" } });
    }
    throw new Error(`Unhandled fixture route: ${route}`);
  });
  const client = new StraylabsClient({ baseUrl, apiKey: "key", fetch: mock.fetch });
  const sync = (attribution = true) => synchronize(client, store, "app-org", input.requestId, async () => attribution);
  return { client, store, state, sync, calls: mock.calls };
}

test("fresh and repeated launch persist separate identities without duplicate mutations", async () => {
  const { client, store, state } = setup();
  await launch(client, store, input);
  const record = await launch(client, store, input);
  expect(record.projectId).toBe(ref.projectId);
  expect(record.scanId).toBe(scanRef.scanId);
  expect(state.creates).toBe(1); expect(state.starts).toBe(1);
});

test.each(["loseCreate", "loseStart"] as const)("durable launch recovers %s using reads on the next invocation", async failure => {
  const { client, store, state } = setup(); state[failure] = true;
  await expect(launch(client, store, input)).rejects.toBeInstanceOf(StraylabsTransportError);
  expect((await store.load(input.requestId))!.stage).toBe(failure === "loseCreate" ? "create_pending" : "start_pending");
  expect((await launch(client, store, input)).scanId).toBe(scanRef.scanId);
  expect(state.creates).toBe(1); expect(state.starts).toBe(1);
});

test("unresolved launch never dispatches a second create or start", async () => {
  const { client, store, state } = setup(); state.loseStart = true;
  await expect(launch(client, store, input)).rejects.toBeInstanceOf(StraylabsTransportError);
  state.scanStarted = false; // History has no uniquely identifiable new scan.
  await expect(launch(client, store, input)).rejects.toBeInstanceOf(ReconciliationRequired);
  expect(state.starts).toBe(1);
});

test("per-organization reservation rejects another pentest before HTTP", async () => {
  const { client, store, state } = setup();
  await launch(client, store, input);
  await expect(launch(client, store, { ...input, requestId: "request-456" })).rejects.toBeInstanceOf(ReconciliationRequired);
  expect(state.creates).toBe(1);
});

test("concurrent cron and manual refresh serialize and enqueue generation once", async () => {
  const { client, store, state, sync } = setup();
  await launch(client, store, input); state.completed = true;
  await Promise.all([sync(), sync()]);
  expect(state.generates).toBe(1);
  expect((await store.load(input.requestId))!.stage).toBe("report_pending");
});

test("lost report response retains inventory and does not enqueue generation on refresh", async () => {
  const { client, store, state, sync } = setup();
  await launch(client, store, input); state.completed = true; state.loseGenerate = true;
  await expect(sync()).rejects.toBeInstanceOf(StraylabsTransportError);
  expect((await store.load(input.requestId))!.reportsBeforeGeneration).toEqual([]);
  await sync(); await sync(); expect(state.generates).toBe(1);
});

test("Markdown-only report stays pending; multiple candidates require attribution", async () => {
  const { client, store, state, sync } = setup();
  await launch(client, store, input); state.completed = true; await sync();
  state.reports = [report("9", false)]; await sync(); expect(state.downloads).toBe(0);
  state.reports = [report("9"), report("10")];
  await expect(sync()).rejects.toBeInstanceOf(ReconciliationRequired);
  expect(state.downloads).toBe(0);
});

test("a candidate is not evidence until deployment attribution is established", async () => {
  const { client, store, state, sync } = setup();
  await launch(client, store, input); state.completed = true; await sync(); state.reports = [report("1")];
  await expect(sync(false)).rejects.toBeInstanceOf(ReconciliationRequired);
  expect(store.evidence.size).toBe(0); expect(state.downloads).toBe(0);
});

test("delivery retry after upload and repeated sync do not create duplicate evidence", async () => {
  const { client, store, state, sync } = setup();
  await launch(client, store, input); state.completed = true; await sync();
  state.reports = [report("1")]; store.failAfterUpload = true;
  await expect(sync()).rejects.toThrow("Crash after upload");
  expect(store.evidence.size).toBe(1);
  await Promise.all([sync(), sync()]); await sync();
  expect(store.evidence.size).toBe(1);
  expect((await store.load(input.requestId))!.stage).toBe("completed");
  expect(state.generates).toBe(1);
});

test("repeated finding upserts retain human triage; empty lists do not resolve absent findings", async () => {
  const { client, store, state, sync } = setup();
  await launch(client, store, input); state.completed = true; await sync();
  const row = [...store.rows.values()][0]!; row.triage = "accepted_risk"; row.assignee = "alice";
  state.findings = [finding({ description: "Updated provider text", confirmation_status: "resolved" })];
  await sync(); await sync();
  expect(store.rows.size).toBe(1);
  expect([...store.rows.values()][0]).toMatchObject({ triage: "accepted_risk", assignee: "alice", provider: { description: "Updated provider text" } });
  state.findings = []; await sync(); expect(store.rows.size).toBe(1);
});

const run: ScanTaskRunOut = { id: "database-row-id", task_id: "task-1", task_title: "Test", run_id: "run-1", outcome: "negative", ran_at: "2026-11-02T14:00:00Z", ended_at: "2026-11-02T14:01:00Z" };
test("verification evidence requires matching settled run_id, task, project and known outcome", () => {
  const resolved = finding({ confirmation_status: "resolved" });
  const detail = scan({ task_runs: [run] });
  expect(verificationEvidence(resolved, scanRef, detail)?.outcome).toBe("negative");
  expect(verificationEvidence(finding(), scanRef, scan({ task_runs: [{ ...run, outcome: "confirmed_finding" }] }))?.outcome).toBe("confirmed_finding");
  for (const change of [{ run_id: "other" }, { run_id: null }, { task_id: "other" }, { ended_at: null }, { outcome: null }, { outcome: "failed" }, { outcome: "future" }]) {
    expect(verificationEvidence(resolved, scanRef, scan({ task_runs: [{ ...run, ...change }] }))).toBeUndefined();
  }
  // A manual edit with no run and a join on the database row id are insufficient.
  expect(verificationEvidence(resolved, scanRef, scan())).toBeUndefined();
  expect(verificationEvidence(finding({ last_run_id: run.id, confirmation_status: "resolved" }), scanRef, detail)).toBeUndefined();
  expect(verificationEvidence(finding({ project_id: "other", confirmation_status: "resolved" }), scanRef, detail)).toBeUndefined();
  expect(verificationEvidence(resolved, scanRef, scan({ id: "other", task_runs: [run] }))).toBeUndefined();
  expect(verificationEvidence(finding({ confirmation_status: "accepted_risk" }), scanRef, detail)).toBeUndefined();
});
