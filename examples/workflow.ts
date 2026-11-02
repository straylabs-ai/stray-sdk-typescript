/** Reference application orchestration. Supply durable storage and a distributed
 * lock; this module is an example, not part of the SDK's public exports. */
import { createHash } from "node:crypto";
import { StraylabsClient } from "@straylabs/sdk";
import type { BlackboxProjectInput, FindingOut, ProjectOut, ReportDownload, ReportFile, ScanDetailOut, ScanRef } from "@straylabs/sdk";

export type WorkflowRecord = {
  requestId: string;
  applicationOrganizationId: string;
  organizationId: string;
  input: BlackboxProjectInput;
  stage: "create_pending" | "project_ready" | "start_pending" | "running" | "report_pending" | "completed" | "failed" | "cancelled";
  projectId?: string;
  scanId?: string;
  scanIdsBeforeStart?: string[];
  providerScan?: ScanDetailOut;
  reportsBeforeGeneration?: ReportFile[];
  reportRequestedAt?: string;
  reportJobId?: string;
  evidenceId?: string;
};
export type LaunchInput = Pick<WorkflowRecord, "requestId" | "applicationOrganizationId" | "organizationId" | "input">;
export interface WorkflowStore {
  /** Lock/transaction must cover ALL requests for the application organization,
   * with a durable reservation held until evidence delivery or reconciliation. */
  withOrganization<T>(id: string, operation: () => Promise<T>): Promise<T>;
  load(requestId: string): Promise<WorkflowRecord | undefined>;
  /** On first insert, atomically reserve the application organization: reject
   * another request while an earlier reservation is active, even across jobs. */
  save(record: WorkflowRecord): Promise<void>;
  /** Upsert by (application organization, source=straylabs, finding.id).
   * Update provider columns only; keep assignee, comments and treatment state. */
  upsertProviderFindings(record: WorkflowRecord, findings: FindingOut[]): Promise<void>;
  /** Upload to evidence storage idempotently by original filename + SHA-256,
   * then atomically checkpoint evidence and completion in the application DB. */
  commitDelivery(record: WorkflowRecord, report: ReportDownload, sha256: string): Promise<void>;
}
export class ReconciliationRequired extends Error {}

function matchesConfiguration(project: ProjectOut, input: BlackboxProjectInput): boolean {
  return project.project_name === input.project_name && project.type === "black-box"
    && JSON.stringify(project.targets) === JSON.stringify(input.targets) && project.scope === input.scope
    && project.exclusions === (input.exclusions ?? "")
    && project.certification_requirements === (input.certification_requirements ?? "iso27001")
    && (project.environment ?? null) === (input.environment ?? null)
    && project.testing_accounts.accounts?.length === 0
    && project.testing_accounts.login_page == null && project.testing_accounts.refresh_page == null
    && project.testing_accounts.auth_policy?.allow_account_creation === false
    && project.testing_accounts.auth_policy.max_accounts === 0
    && Object.keys(project.architectural_resources ?? {}).length === 0;
}

/** Each POST has a persisted intent. An existing pending intent is reconciled
 * using reads; zero/multiple candidates require an operator, never another POST. */
export async function launch(client: StraylabsClient, store: WorkflowStore, input: LaunchInput): Promise<WorkflowRecord> {
  return store.withOrganization(input.applicationOrganizationId, async () => {
    let record = await store.load(input.requestId);
    const fresh = !record;
    if (!record) {
      record = { ...input, stage: "create_pending" };
      await store.save(record);
    } else if (record.applicationOrganizationId !== input.applicationOrganizationId
      || record.organizationId !== input.organizationId || JSON.stringify(record.input) !== JSON.stringify(input.input)) {
      throw new ReconciliationRequired("The saved tenant mapping or launch configuration differs.");
    }
    if (record.stage === "create_pending") {
      let project: ProjectOut;
      if (fresh) project = await client.projects.createBlackbox(record.organizationId, record.input);
      else {
        const matches = (await client.projects.list(record.organizationId)).filter(project => project.project_name === record.input.project_name);
        if (matches.length !== 1 || !matchesConfiguration(matches[0]!, record.input)) {
          throw new ReconciliationRequired("The project-create outcome could not be uniquely reconciled.");
        }
        project = matches[0]!;
      }
      record.projectId = project.id;
      record.stage = "project_ready";
      await store.save(record);
    }
    if (!record.projectId) throw new ReconciliationRequired("The workflow has no project checkpoint.");
    const ref = { organizationId: record.organizationId, projectId: record.projectId };
    if (record.stage === "start_pending") {
      if (!record.scanIdsBeforeStart) throw new ReconciliationRequired("The pre-start scan snapshot is missing.");
      const before = new Set(record.scanIdsBeforeStart);
      const candidates = (await client.scans.list(ref)).filter(scan => !before.has(scan.id));
      const project = await client.projects.get(ref);
      if (candidates.length !== 1 || candidates[0]!.trigger !== "api"
        || (project.current_scan_id && project.current_scan_id !== candidates[0]!.id)) {
        throw new ReconciliationRequired("The scan-start outcome could not be uniquely reconciled.");
      }
      record.scanId = candidates[0]!.id;
      record.stage = "running";
      await store.save(record);
    } else if (record.stage === "project_ready") {
      record.scanIdsBeforeStart = (await client.scans.list(ref)).map(scan => scan.id);
      record.stage = "start_pending";
      await store.save(record);
      const started = await client.scans.start(ref);
      if (!started.current_scan_id) throw new ReconciliationRequired("Start returned no scan ID; reconcile history on the next pass.");
      record.scanId = started.current_scan_id;
      record.stage = "running";
      await store.save(record);
    }
    return record;
  });
}

/** One bounded cron/manual refresh pass. Attribution policy must establish
 * exclusive project use, including external users and outstanding report jobs. */
export async function synchronize(
  client: StraylabsClient, store: WorkflowStore,
  applicationOrganizationId: string, requestId: string,
  canAttributeReport: (record: WorkflowRecord, candidate: ReportFile) => Promise<boolean>,
): Promise<void> {
  await store.withOrganization(applicationOrganizationId, async () => {
    const record = await store.load(requestId);
    if (!record || record.applicationOrganizationId !== applicationOrganizationId) throw new ReconciliationRequired("Missing trusted workflow mapping.");
    if (["completed", "failed", "cancelled"].includes(record.stage)) return;
    if (!record.projectId || !record.scanId) throw new ReconciliationRequired("Launch must be reconciled before synchronization.");
    const ref: ScanRef = { organizationId: record.organizationId, projectId: record.projectId, scanId: record.scanId };
    const scan = await client.scans.get(ref);
    record.providerScan = scan;
    await store.save(record);
    if (scan.status === "running") return;
    if (scan.status === "failed" || scan.status === "abandoned") {
      record.stage = scan.status === "failed" ? "failed" : "cancelled";
      await store.save(record);
      return;
    }
    if (scan.status !== "completed") throw new ReconciliationRequired("Unknown provider scan status.");
    const findings = await client.findings.list(ref);
    await store.upsertProviderFindings(record, findings);
    // Current scan summaries supply the subset for this assessment. The store
    // may persist this association but must not call it an immutable snapshot.
    const eligible = (await client.scans.list(ref)).find(item => item.status === "completed" || item.status === "failed");
    if (eligible?.id !== record.scanId) throw new ReconciliationRequired("A different scan would be selected by report generation.");
    if (record.stage !== "report_pending") {
      record.reportsBeforeGeneration = (await client.reports.list(ref)).reports;
      record.reportRequestedAt = new Date().toISOString();
      record.stage = "report_pending";
      await store.save(record);
      record.reportJobId = (await client.reports.generate(ref)).job_id;
      await store.save(record);
      return;
    }
    if (!record.reportsBeforeGeneration || !record.reportRequestedAt) throw new ReconciliationRequired("The report-generation checkpoint is incomplete.");
    const baseline = new Set(record.reportsBeforeGeneration?.map(report => report.markdown_filename));
    const candidates = (await client.reports.list(ref)).reports.filter(report => !baseline.has(report.markdown_filename));
    if (!candidates.length) return;
    if (candidates.length !== 1) throw new ReconciliationRequired("Multiple new report candidates require attribution.");
    const candidate = candidates[0]!;
    if (!candidate.pdf_filename) return;
    if (!await canAttributeReport(record, candidate)) throw new ReconciliationRequired("Report-to-scan attribution is not established.");
    const downloaded = await client.reports.download(ref, candidate.pdf_filename);
    if (downloaded.contentType.split(";")[0]!.trim().toLowerCase() !== "application/pdf"
      || new TextDecoder().decode(downloaded.bytes.subarray(0, 5)) !== "%PDF-") {
      throw new ReconciliationRequired("PDF evidence is not available.");
    }
    // Use the listing filename as evidence identity; attachment metadata is only a display name.
    downloaded.filename = candidate.pdf_filename;
    const sha256 = createHash("sha256").update(downloaded.bytes).digest("hex");
    await store.commitDelivery(record, downloaded, sha256);
  });
}

/** Evidence hint, not an automatic treatment decision. Applications must also
 * compare saved confirmed/resolved history, process each run once, and preserve
 * human triage. Manual status edits or unmatched runs produce no evidence. */
export function verificationEvidence(finding: FindingOut, ref: ScanRef, scan: ScanDetailOut) {
  if (finding.project_id !== ref.projectId || scan.id !== ref.scanId || !finding.last_run_id) return undefined;
  const run = scan.task_runs?.find(run => run.run_id === finding.last_run_id && run.task_id === finding.task_id && !!run.ended_at);
  if (!run) return undefined;
  if ((run.outcome === "negative" && finding.confirmation_status === "resolved")
    || (run.outcome === "confirmed_finding" && ["review", "valid"].includes(finding.confirmation_status))) {
    return { scanId: scan.id, runId: run.run_id!, taskId: run.task_id, outcome: run.outcome, endedAt: run.ended_at! };
  }
  return undefined;
}
