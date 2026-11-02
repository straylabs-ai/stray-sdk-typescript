import type { CertificationRequirement, Environment, ProjectCreate as WireProjectCreate } from "./generated/wire.js";

export type {
  MyOrganizationOut, ProjectOut, ScanListItemOut, ScanDetailOut,
  FindingOut, Environment, CertificationRequirement,
  TestingAccount, TestingAccountOut, TestingAccountsConfig, TestingAccountsConfigOut, AuthPolicy,
  OrganizationTier, ScanFindingOut, ScanTaskRunOut, ScanReconRunOut,
  ScanPhaseProgressOut, ScanSummaryOut,
  ReconSecurityTestTaskOut, SecurityTestTaskGenerationOut, SecurityTestExecutionConcurrencyOut,
  ReconSecurityHeaderOut, ReconPortScanOut,
} from "./generated/wire.js";

/** Project types supported for SDK creation. Historical responses retain their wire type. */
export type ProjectType = "black-box" | "grey-box";
export type ProjectCreate = Omit<WireProjectCreate, "type"> & {
  /** Defaults to black-box when omitted. */
  type?: ProjectType;
};

export type ProjectRef = { organizationId: string; projectId: string };
export type ScanRef = ProjectRef & { scanId: string };
export type RequestOptions = { signal?: AbortSignal; timeoutMs?: number };
export type ClientOptions = {
  /** API root, including any deployment prefix. Default: https://platform.straylabs.ai/api */
  baseUrl?: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  /** Whole operation, including body reads, retry delays and all attempts. Default: 30,000. */
  timeoutMs?: number;
  /** GET retries after the first attempt. Default: 2. POST is never retried. */
  maxReadRetries?: number;
};
export type BlackboxProjectInput = {
  project_name: string;
  targets: string[];
  scope: string;
  exclusions?: string;
  certification_requirements?: CertificationRequirement;
  environment?: Environment | null;
};
// Deliberate overrides: OpenAPI declares generic JSON for these report routes.
export type ReportGeneration = { project_id: string; job_id: string; status: "queued" };
export type ReportFile = {
  stem: string;
  markdown_filename: string;
  pdf_filename: string | null;
  created_at: string;
};
export type ReportList = { reports: ReportFile[] };
export type ReportDownload = { filename: string; contentType: string; bytes: Uint8Array };
