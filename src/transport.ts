import { Deadline } from "./deadline.js";
import { DEFAULT_BASE_URL } from "./constants.js";
import {
  StraylabsError, StraylabsHttpError, StraylabsInputError,
  StraylabsProtocolError, StraylabsTransportError,
} from "./errors.js";
import type { RequestContext } from "./errors.js";
import { schemas } from "./generated/schemas.js";
import { matches } from "./schema.js";
import type { Schema } from "./schema.js";
import type { ClientOptions, ProjectRef, ScanRef, RequestOptions, ReportDownload } from "./types.js";
import { isFilename, normalizeBaseUrl, positiveDuration } from "./validation.js";

type ResponseContract = { status: number; schema: Schema } | { status: number; filename: string };
const retryStatuses = new Set([429, 502, 503, 504]);

function retryAfter(value: string | null): number | undefined {
  if (!value?.trim()) return undefined;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/u.test(trimmed)) {
    const ms = Number(trimmed) * 1000;
    return Number.isFinite(ms) ? ms : undefined;
  }
  // Date.parse also accepts arbitrary numbers. Require an HTTP-date shape.
  if (!/^(?:[A-Za-z]{3},? |[A-Za-z]+, )/u.test(trimmed)) return undefined;
  const timestamp = Date.parse(trimmed);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}

function attachmentFilename(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const extended = /(?:^|;)\s*filename\*=UTF-8''([^;]+)/iu.exec(header);
  const plain = /(?:^|;)\s*filename=(?:"([^"]*)"|([^;]*))/iu.exec(header);
  let candidate: string | undefined;
  try { candidate = extended ? decodeURIComponent(extended[1]!.trim()) : plain?.[1] ?? plain?.[2]?.trim(); }
  catch { return fallback; }
  return isFilename(candidate) ? candidate : fallback;
}

export class Transport {
  readonly timeoutMs: number;
  #baseUrl: string;
  #apiKey: string;
  #fetch: typeof globalThis.fetch;
  #maxReadRetries: number;
  constructor(options: ClientOptions) {
    if (!options || typeof options !== "object") throw new StraylabsInputError("Client options are required.");
    this.#baseUrl = normalizeBaseUrl(options.baseUrl === undefined ? DEFAULT_BASE_URL : options.baseUrl);
    if (typeof options.apiKey !== "string" || !options.apiKey.trim() || /[\u0000-\u001f\u007f]/u.test(options.apiKey)) {
      throw new StraylabsInputError("A non-empty API key suitable for an HTTP header is required.");
    }
    try { new Headers({ "x-api-key": options.apiKey }); }
    catch { throw new StraylabsInputError("The API key is not a valid HTTP header value."); }
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== "function") throw new StraylabsInputError("A fetch implementation is required.");
    this.timeoutMs = positiveDuration(options.timeoutMs ?? 30_000, "timeoutMs");
    this.#maxReadRetries = options.maxReadRetries ?? 2;
    if (!Number.isSafeInteger(this.#maxReadRetries) || this.#maxReadRetries < 0) throw new StraylabsInputError("maxReadRetries must be a non-negative safe integer.");
  }

  #redact(value: unknown): unknown {
    if (typeof value === "string") {
      return value.split(this.#apiKey).join("[REDACTED]")
        .split(encodeURIComponent(this.#apiKey)).join("[REDACTED]");
    }
    if (Array.isArray(value)) return value.map(item => this.#redact(item));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      String(this.#redact(key)), /api[_-]?key|authorization|password|secret|token|cookie/iu.test(key) ? "[REDACTED]" : this.#redact(item),
    ]));
    return value;
  }

  sanitize<T>(value: T): T { return this.#redact(value) as T; }

  async request<T>(
    method: "GET" | "POST", route: string, contract: ResponseContract,
    options: RequestOptions = {}, body?: unknown, ref?: ProjectRef | ScanRef,
  ): Promise<T> {
    const timeout = positiveDuration(options.timeoutMs ?? this.timeoutMs, "timeoutMs");
    let serialized: string | undefined;
    if (body !== undefined) {
      try { serialized = JSON.stringify(body); }
      catch { throw new StraylabsInputError("The request body must be JSON serializable."); }
      if (serialized === undefined) throw new StraylabsInputError("The request body must be JSON serializable.");
    }
    const context: RequestContext = this.#redact({ method, route, ref, outcomeUnknown: false }) as RequestContext;
    const deadline = new Deadline(timeout, options.signal);
    try {
      for (let attempt = 0; ; attempt++) {
        deadline.check(context);
        try {
          const response = await deadline.run(() => {
            context.outcomeUnknown = method === "POST";
            return this.#fetch(`${this.#baseUrl}${route}`, {
              method, headers: {
                "x-api-key": this.#apiKey,
                Accept: "filename" in contract ? "application/pdf, text/markdown" : "application/json",
                ...(serialized !== undefined ? { "Content-Type": "application/json" } : {}),
              },
              ...(serialized !== undefined ? { body: serialized } : {}),
              signal: deadline.controller.signal,
              redirect: "error",
              credentials: "omit",
              cache: "no-store",
            });
          }, context);
          if (!response.ok) {
            context.outcomeUnknown = method === "POST" && response.status >= 500;
            let raw: string | undefined;
            try { raw = await deadline.run(() => response.text(), context); }
            catch (error) {
              if (error instanceof StraylabsError) throw error;
              // A broken error body must not hide a known auth/validation status
              // or drop the Retry-After minimum from already received headers.
            }
            let parsed: unknown = raw;
            try { if (raw !== undefined) parsed = JSON.parse(raw); } catch { /* Proxies can return plain text or HTML. */ }
            const safe = this.#redact(parsed);
            const detail = safe && typeof safe === "object" && "detail" in safe ? safe.detail : safe;
            throw new StraylabsHttpError(
              typeof detail === "string" && detail.trim() ? detail : `HTTP ${response.status} from Straylabs.`,
              response.status, safe, context,
              this.#redact(response.headers.get("x-request-id") ?? response.headers.get("x-correlation-id") ?? response.headers.get("traceparent") ?? undefined) as string | undefined,
              retryAfter(response.headers.get("retry-after")),
            );
          }
          if (response.status !== contract.status) {
            void response.body?.cancel().catch(() => {});
            throw new StraylabsProtocolError(`Unexpected success status ${response.status}; expected ${contract.status}.`, context);
          }
          if ("filename" in contract) {
            const contentType = response.headers.get("content-type") ?? "";
            if (!["application/pdf", "text/markdown"].includes(contentType.split(";")[0]!.trim().toLowerCase())) {
              void response.body?.cancel().catch(() => {});
              throw new StraylabsProtocolError("The report response is not PDF or Markdown.", context);
            }
            const bytes = new Uint8Array(await deadline.run(() => response.arrayBuffer(), context));
            deadline.check(context);
            return { bytes, contentType, filename: attachmentFilename(response.headers.get("content-disposition"), contract.filename) } as ReportDownload as T;
          }
          const raw = await deadline.run(() => response.text(), context);
          let parsed: unknown;
          try { parsed = JSON.parse(raw); }
          catch { throw new StraylabsProtocolError("The successful response did not contain valid JSON.", context); }
          if (!matches(parsed, contract.schema, schemas)) {
            throw new StraylabsProtocolError("The successful response does not match the required API shape.", context);
          }
          deadline.check(context);
          return parsed as T;
        } catch (cause) {
          deadline.check(context);
          const error = cause instanceof StraylabsError ? cause : new StraylabsTransportError(
            "The request or response body could not be received.", context,
            { cause: new Error(String(this.#redact(cause instanceof Error ? cause.message : String(cause)))) },
          );
          const retryable = error instanceof StraylabsTransportError
            || (error instanceof StraylabsHttpError && retryStatuses.has(error.status));
          if (method !== "GET" || !retryable || attempt >= this.#maxReadRetries) throw error;
          const backoff = Math.min(30_000, 1_000 * 2 ** attempt) * (0.5 + Math.random() * 0.5);
          await deadline.sleep(Math.max(backoff, error instanceof StraylabsHttpError ? error.retryAfterMs ?? 0 : 0), context);
        }
      }
    } finally { deadline.close(); }
  }
}
