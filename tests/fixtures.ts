import type { FindingOut, MyOrganizationOut, ProjectOut, ScanDetailOut } from "../src/index.js";

export const ref = { organizationId: "11111111-1111-4111-8111-111111111111", projectId: "22222222-2222-4222-8222-222222222222" };
export const scanRef = { ...ref, scanId: "33333333-3333-4333-8333-333333333333" };
export const baseUrl = "https://deployment.example/api";
export const projectRoute = `/organizations/${ref.organizationId}/projects/${ref.projectId}`;
export const organization: MyOrganizationOut = { id: ref.organizationId, name: "Customer", is_owner: true, tier: "enterprise" };

export function project(overrides: Partial<ProjectOut> = {}): ProjectOut {
  return {
    id: ref.projectId, organization_id: ref.organizationId, owner_id: "owner",
    project_name: "request-123", targets: ["https://app.customer.example/path?a=1"], scope: "Public application",
    exclusions: "", certification_requirements: "iso27001", environment: null, type: "black-box",
    testing_accounts: { accounts: [], auth_policy: { allow_account_creation: false, max_accounts: 0 } }, architectural_resources: {},
    created_at: "2026-11-02T13:00:00+01:00", current_scan_id: null, scan_status: "idle", scan_phase: null,
    security_test_execution: { max_slots: 1, running_count: 0, remaining_slots: 1, can_start_run: true },
    ...overrides,
  };
}

export function scan(overrides: Partial<ScanDetailOut> = {}): ScanDetailOut {
  return {
    id: scanRef.scanId, sequence_number: 1, trigger: "api", status: "running",
    phases: { recon: "completed", generation: "completed", execution: "active" },
    started_at: null, ended_at: null, duration_seconds: null, progress_percent: 100,
    task_runs: [], findings: [], ...overrides,
  };
}

export function finding(overrides: Partial<FindingOut> = {}): FindingOut {
  return {
    id: "finding-1", project_id: ref.projectId, task_id: "task-1", last_run_id: "run-1",
    title: "SQL injection", severity_rating: "Critical", cvss_score: 9.8, cvss_vector: null,
    severity_rationale: "Public access", confirmation_status: "review", cwe_ids: ["CWE-89", "CWE-20"],
    affected_components: ["login service", "https://app.customer.example/login"],
    description: "Query input is unsafe", steps_to_reproduce: "Submit the recorded payload\nObserve the response.",
    remediation: "Parameterize queries", markdown: "# Evidence", first_seen_at: null,
    last_confirmed_at: "2026-11-02T14:00:00+01:00", last_run_at: null, resolved_at: null,
    accepted_risk_at: null, created_at: null, updated_at: "2026-11-02T14:00:00+01:00", ...overrides,
  };
}

export type CapturedRequest = { url: string; init: RequestInit };
export function mockFetch(handler: (request: CapturedRequest) => Response | Promise<Response>) {
  const calls: CapturedRequest[] = [];
  const fetch = (async (input, init) => {
    const request = { url: String(input), init: init ?? {} };
    calls.push(request);
    return handler(request);
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}
