import { StraylabsInputError } from "./errors.js";
import type { BlackboxProjectInput, ProjectCreate, ProjectRef } from "./types.js";

export function positiveDuration(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) {
    throw new StraylabsInputError(`${name} must be positive and at most 2,147,483,647 milliseconds.`);
  }
  return value;
}

export function projectCreateBody(input: ProjectCreate): ProjectCreate {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new StraylabsInputError("A project input is required.");
  }
  const type = input.type === undefined ? "black-box" : input.type;
  if (type !== "black-box" && type !== "grey-box") {
    throw new StraylabsInputError("Project type must be black-box or grey-box.");
  }
  return { ...input, type };
}

export function segment(value: string): string {
  if (typeof value !== "string" || !value.trim() || value === "." || value === ".." || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new StraylabsInputError("Resource identifiers must be non-empty path segments.");
  }
  try { return encodeURIComponent(value); }
  catch { throw new StraylabsInputError("Resource identifiers must contain valid Unicode."); }
}

export function projectPath(ref: ProjectRef): string {
  if (!ref || typeof ref !== "object") throw new StraylabsInputError("A project reference is required.");
  return `/organizations/${segment(ref.organizationId)}/projects/${segment(ref.projectId)}`;
}

export function isFilename(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value !== "." && value !== ".."
    && !/[\\/\u0000-\u001f\u007f]/u.test(value);
}

export function filenameSegment(value: string): string {
  if (!isFilename(value)) throw new StraylabsInputError("A report filename must be a single filename without path traversal.");
  return segment(value);
}

export function normalizeBaseUrl(value: string): string {
  if (typeof value !== "string" || !/^https?:\/\/[^/]/iu.test(value)
    || value !== value.trim() || /[\u0000-\u0020\\\u007f?#]/u.test(value)) {
    throw new StraylabsInputError("baseUrl must be an absolute URL without credentials, query, or fragment.");
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new StraylabsInputError("baseUrl must be an absolute URL."); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && local))
    || url.username || url.password || value.split("/")[2]?.includes("@")) {
    throw new StraylabsInputError("baseUrl requires HTTPS (HTTP is allowed on loopback) and no embedded credentials.");
  }
  return url.href.replace(/\/+$/u, "");
}

function publicIpv4(host: string): boolean {
  const [a = 0, b = 0, c = 0] = host.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113));
}

function publicIpv6(host: string): boolean {
  // URL canonicalizes IPv6, including embedded IPv4. Accept global unicast and
  // conservatively exclude special-purpose and transition ranges; no DNS lookup.
  const words = host.slice(1, -1).split(":");
  const first = Number.parseInt(words[0] || "0", 16);
  const second = Number.parseInt(words[1] || "0", 16);
  return first >= 0x2000 && first <= 0x3fff
    && !(first === 0x2001 && (second < 0x200 || second === 0xdb8))
    && first !== 0x2002 && !(first === 0x3fff && second < 0x1000);
}

function validateTarget(value: unknown): void {
  const invalid = () => new StraylabsInputError("Blackbox targets must be unambiguous absolute HTTPS URLs with public hosts and no credentials.");
  if (typeof value !== "string" || !/^https:\/\/[^/]/iu.test(value) || /[\u0000-\u0020\\\u007f]/u.test(value)) throw invalid();
  let url: URL;
  try { url = new URL(value); } catch { throw invalid(); }
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (!host || url.username || url.password || value.split("/")[2]?.includes("@")
    || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".localdomain")) throw invalid();
  if (host.startsWith("[")) {
    if (!publicIpv6(host)) throw invalid();
  } else if (/^\d+\.\d+\.\d+\.\d+$/u.test(host)) {
    if (!publicIpv4(host)) throw invalid();
  } else if (!host.includes(".") || !host.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) {
    throw invalid();
  }
}

export function blackboxBody(input: BlackboxProjectInput): ProjectCreate {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new StraylabsInputError("A blackbox project input is required.");
  const allowed = new Set(["project_name", "targets", "scope", "exclusions", "certification_requirements", "environment"]);
  if (Reflect.ownKeys(input).some(key => typeof key !== "string" || !allowed.has(key))) {
    throw new StraylabsInputError("Unexpected blackbox input field; credentials, architecture, and testing overrides are not accepted.");
  }
  if (typeof input.project_name !== "string" || !input.project_name.trim()
    || typeof input.scope !== "string" || !input.scope.trim()
    || !Array.isArray(input.targets) || !input.targets.length) {
    throw new StraylabsInputError("Blackbox projects require a non-empty project_name, scope, and targets array.");
  }
  input.targets.forEach(validateTarget);
  if (input.exclusions !== undefined && typeof input.exclusions !== "string") throw new StraylabsInputError("exclusions must be a string.");
  if (input.certification_requirements !== undefined && !["iso27001", "SOC2"].includes(input.certification_requirements)) {
    throw new StraylabsInputError("Unsupported certification_requirements.");
  }
  if (input.environment !== undefined && input.environment !== null && !["dev", "pre", "staging", "prod"].includes(input.environment)) {
    throw new StraylabsInputError("Unsupported environment.");
  }
  return {
    project_name: input.project_name,
    targets: [...input.targets],
    scope: input.scope,
    exclusions: input.exclusions ?? "",
    certification_requirements: input.certification_requirements ?? "iso27001",
    ...(input.environment !== undefined ? { environment: input.environment } : {}),
    type: "black-box",
    testing_accounts: {
      accounts: [], login_page: null, refresh_page: null,
      auth_policy: { allow_account_creation: false, max_accounts: 0 },
    },
    architectural_resources: {},
  };
}
