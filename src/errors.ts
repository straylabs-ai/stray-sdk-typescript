import type { ProjectRef, ScanRef } from "./types.js";

export type RequestContext = {
  method?: "GET" | "POST";
  /** API-relative route, without credentials or the base URL. */
  route?: string;
  ref?: ProjectRef | ScanRef;
  outcomeUnknown?: boolean;
};

export class StraylabsError extends Error {
  readonly method?: "GET" | "POST";
  readonly route?: string;
  readonly ref?: ProjectRef | ScanRef;
  readonly outcomeUnknown: boolean;
  constructor(message: string, context: RequestContext = {}, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.method = context.method;
    this.route = context.route;
    this.ref = context.ref;
    this.outcomeUnknown = context.outcomeUnknown ?? false;
  }
}
export class StraylabsInputError extends StraylabsError {}
export class StraylabsTransportError extends StraylabsError {}
export class StraylabsProtocolError extends StraylabsError {}
export class StraylabsTimeoutError extends StraylabsError {}
export class StraylabsAbortError extends StraylabsError {}

export class StraylabsOrganizationLookupError extends StraylabsError {
  constructor(readonly organizationName: string, readonly reason: "not_found" | "ambiguous") {
    super(reason === "not_found"
      ? "No accessible organization matches the requested name."
      : "Several accessible organizations share the requested name; select an organization by ID.",
    { method: "GET", route: "/me/organizations" });
  }
}

export class StraylabsHttpError extends StraylabsError {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
    context: RequestContext,
    readonly correlationId?: string,
    readonly retryAfterMs?: number,
  ) { super(message, context); }
  get detail(): unknown {
    return this.body && typeof this.body === "object" && "detail" in this.body ? this.body.detail : this.body;
  }
}
