import { Deadline } from "./deadline.js";
import { StraylabsHttpError, StraylabsInputError, StraylabsOrganizationLookupError, StraylabsProtocolError } from "./errors.js";
import type { RequestContext } from "./errors.js";
import { Transport } from "./transport.js";
import { blackboxBody, filenameSegment, positiveDuration, projectCreateBody, projectPath, segment } from "./validation.js";
import type { Schema } from "./schema.js";
import type {
  BlackboxProjectInput, ClientOptions, FindingOut, MyOrganizationOut, ProjectCreate,
  ProjectOut, ProjectRef, ReportDownload, ReportGeneration, ReportList,
  RequestOptions, ScanDetailOut, ScanListItemOut, ScanRef,
} from "./types.js";

const wire = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const list = (name: string): Schema => ({ type: "array", items: wire(name) });
const string: Schema = { type: "string", minLength: 1 };
const generation: Schema = {
  type: "object", required: ["project_id", "job_id", "status"],
  properties: { project_id: string, job_id: string, status: { enum: ["queued"] } },
};
const reports: Schema = {
  type: "object", required: ["reports"], properties: {
    reports: { type: "array", items: {
      type: "object", required: ["stem", "markdown_filename", "pdf_filename", "created_at"],
      properties: { stem: string, markdown_filename: string, pdf_filename: { anyOf: [string, { type: "null" }] }, created_at: string },
    } },
  },
};
const reportFilenameOrder = new Intl.Collator("en", { numeric: true, sensitivity: "variant" });

/** API-key client for explicit organization/project/scan references. Server use only. */
export class StraylabsClient {
  #transport: Transport;
  constructor(options: ClientOptions) { this.#transport = new Transport(options); }

  readonly organizations = {
    list: (options?: RequestOptions): Promise<MyOrganizationOut[]> =>
      this.#transport.request("GET", "/me/organizations", { status: 200, schema: list("MyOrganizationOut") }, options),
    /** Resolve one exact, case-sensitive name using the accessible organization list. */
    getByName: async (name: string, options?: RequestOptions): Promise<MyOrganizationOut> => {
      if (typeof name !== "string" || !name.trim()) throw new StraylabsInputError("A non-empty organization name is required.");
      const matches = (await this.organizations.list(options)).filter(organization => organization.name === name);
      if (matches.length !== 1) {
        throw new StraylabsOrganizationLookupError(this.#transport.sanitize(name), matches.length === 0 ? "not_found" : "ambiguous");
      }
      return matches[0]!;
    },
  };

  readonly projects = {
    list: (organizationId: string, options?: RequestOptions): Promise<ProjectOut[]> =>
      this.#transport.request("GET", `/organizations/${segment(organizationId)}/projects`, { status: 200, schema: list("ProjectOut") }, options),
    create: async (organizationId: string, body: ProjectCreate, options?: RequestOptions): Promise<ProjectOut> =>
      this.#transport.request("POST", `/organizations/${segment(organizationId)}/projects`, { status: 201, schema: wire("ProjectOut") }, options, projectCreateBody(body)),
    createBlackbox: (organizationId: string, body: BlackboxProjectInput, options?: RequestOptions): Promise<ProjectOut> =>
      this.projects.create(organizationId, blackboxBody(body), options),
    get: (ref: ProjectRef, options?: RequestOptions): Promise<ProjectOut> =>
      this.#transport.request("GET", projectPath(ref), { status: 200, schema: wire("ProjectOut") }, options, undefined, ref),
  };

  readonly scans = {
    start: (ref: ProjectRef, options?: RequestOptions): Promise<ProjectOut> =>
      this.#transport.request("POST", `${projectPath(ref)}/start-scan`, { status: 200, schema: wire("ProjectOut") }, options, undefined, ref),
    stop: (ref: ProjectRef, options?: RequestOptions): Promise<ProjectOut> =>
      this.#transport.request("POST", `${projectPath(ref)}/stop-scan`, { status: 200, schema: wire("ProjectOut") }, options, undefined, ref),
    list: (ref: ProjectRef, options?: RequestOptions): Promise<ScanListItemOut[]> =>
      this.#transport.request("GET", `${projectPath(ref)}/scans`, { status: 200, schema: list("ScanListItemOut") }, options, undefined, ref),
    /** Full details for a specific scan, or the latest scan when scanId is omitted. */
    get: this.#getScan.bind(this),
  };

  readonly findings = {
    list: (ref: ProjectRef, options?: RequestOptions): Promise<FindingOut[]> =>
      this.#transport.request("GET", `${projectPath(ref)}/findings`, { status: 200, schema: list("FindingOut") }, options, undefined, ref),
  };

  readonly reports = {
    /** Enqueue generation separately after the scan finishes; returns before the report is ready. */
    generate: (ref: ProjectRef, options?: RequestOptions): Promise<ReportGeneration> =>
      this.#transport.request("POST", `${projectPath(ref)}/reports/generate`, { status: 202, schema: generation }, options, undefined, ref),
    list: (ref: ProjectRef, options?: RequestOptions): Promise<ReportList> =>
      this.#transport.request("GET", `${projectPath(ref)}/reports`, { status: 200, schema: reports }, options, undefined, ref),
    /** Download a named file, or the latest available PDF; latest returns null when unavailable. */
    download: this.#downloadReport.bind(this),
  };

  #downloadReport(ref: ProjectRef, filename: string, options?: RequestOptions): Promise<ReportDownload>;
  #downloadReport(ref: ProjectRef, options?: RequestOptions): Promise<ReportDownload | null>;
  async #downloadReport(ref: ProjectRef, filenameOrOptions?: string | RequestOptions, options: RequestOptions = {}): Promise<ReportDownload | null> {
    const route = `${projectPath(ref)}/reports`;
    if (typeof filenameOrOptions === "string") {
      return this.#transport.request("GET", `${route}/${filenameSegment(filenameOrOptions)}`, { status: 200, filename: filenameOrOptions }, options, undefined, ref);
    }
    const requestOptions = filenameOrOptions ?? {};
    const deadline = new Deadline(positiveDuration(requestOptions.timeoutMs ?? this.#transport.timeoutMs, "timeoutMs"), requestOptions.signal);
    const context: RequestContext = this.#transport.sanitize({ method: "GET", route, ref });
    try {
      const inventory = await deadline.run(() => this.reports.list(ref, {
        timeoutMs: deadline.remaining, signal: deadline.controller.signal,
      }), context);
      let filename: string | null = null;
      let latestTime = -Infinity;
      for (const report of inventory.reports) {
        if (report.pdf_filename === null) continue;
        const time = Date.parse(report.created_at);
        if (!Number.isFinite(time)) throw new StraylabsProtocolError("The report inventory contains an invalid creation timestamp.", context);
        const comparison = filename === null ? 1 : reportFilenameOrder.compare(report.pdf_filename, filename)
          || (report.pdf_filename > filename ? 1 : report.pdf_filename < filename ? -1 : 0);
        if (filename === null || time > latestTime || (time === latestTime && comparison > 0)) {
          filename = report.pdf_filename;
          latestTime = time;
        }
      }
      if (filename === null) return null;
      let encodedFilename: string;
      try { encodedFilename = filenameSegment(filename); }
      catch { throw new StraylabsProtocolError("The report inventory contains an invalid PDF filename.", context); }
      context.route = this.#transport.sanitize(`${route}/${encodedFilename}`);
      try {
        const report = await deadline.run(() => this.#downloadReport(ref, filename!, {
          timeoutMs: deadline.remaining, signal: deadline.controller.signal,
        }), context);
        if (report.contentType.split(";")[0]!.trim().toLowerCase() !== "application/pdf") {
          throw new StraylabsProtocolError("The latest PDF report response has an incompatible content type.", context);
        }
        return report;
      } catch (error) {
        if (error instanceof StraylabsHttpError && error.status === 404) return null;
        throw error;
      }
    } finally { deadline.close(); }
  }

  #getScan(ref: ScanRef, options?: RequestOptions): Promise<ScanDetailOut>;
  #getScan(ref: ProjectRef, options?: RequestOptions): Promise<ScanDetailOut | null>;
  async #getScan(ref: ProjectRef & { scanId?: string }, options: RequestOptions = {}): Promise<ScanDetailOut | null> {
    const scansRoute = `${projectPath(ref)}/scans`;
    if (ref.scanId === undefined) {
      const deadline = new Deadline(positiveDuration(options.timeoutMs ?? this.#transport.timeoutMs, "timeoutMs"), options.signal);
      const context: RequestContext = this.#transport.sanitize({ method: "GET", route: scansRoute, ref });
      try {
        const history = await deadline.run(() => this.scans.list(ref, {
          timeoutMs: deadline.remaining, signal: deadline.controller.signal,
        }), context);
        if (!history.length) return null;
        const scanRef = { ...ref, scanId: history[0]!.id };
        let scanSegment: string;
        try { scanSegment = segment(scanRef.scanId); }
        catch { throw new StraylabsProtocolError("The latest scan has an invalid identity.", context); }
        context.ref = this.#transport.sanitize(scanRef);
        context.route = this.#transport.sanitize(`${scansRoute}/${scanSegment}`);
        return await deadline.run(() => this.#getScan(scanRef, {
          timeoutMs: deadline.remaining, signal: deadline.controller.signal,
        }), context);
      } finally { deadline.close(); }
    }
    const route = `${scansRoute}/${segment(ref.scanId)}`;
    const scan = await this.#transport.request<ScanDetailOut>("GET", route, { status: 200, schema: wire("ScanDetailOut") }, options, undefined, ref);
    if (scan.id !== ref.scanId || typeof scan.status !== "string" || !scan.status) {
      throw new StraylabsProtocolError("The response lacks the requested scan identity or status.", this.#transport.sanitize({ method: "GET", route, ref }));
    }
    return scan;
  }
}
