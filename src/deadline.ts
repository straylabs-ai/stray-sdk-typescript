import { StraylabsAbortError, StraylabsTimeoutError } from "./errors.js";
import type { RequestContext } from "./errors.js";

/** One clock for fetch, response consumption, retries, and related requests. */
export class Deadline {
  readonly controller = new AbortController();
  readonly expiresAt: number;
  #timer: ReturnType<typeof setTimeout>;
  #caller?: AbortSignal;
  #timedOut = false;
  #onAbort = () => this.controller.abort();
  constructor(timeoutMs: number, caller?: AbortSignal) {
    this.expiresAt = performance.now() + timeoutMs;
    this.#caller = caller;
    this.#timer = setTimeout(() => { this.#timedOut = true; this.controller.abort(); }, timeoutMs);
    if (caller?.aborted) this.controller.abort();
    else caller?.addEventListener("abort", this.#onAbort, { once: true });
  }
  get remaining(): number { return Math.max(0, this.expiresAt - performance.now()); }
  check(context: RequestContext): void {
    if (this.#caller?.aborted) throw new StraylabsAbortError("The operation was cancelled by the caller.", context);
    if (this.#timedOut || this.remaining <= 0) throw new StraylabsTimeoutError("The operation deadline expired.", context);
  }
  async run<T>(operation: () => Promise<T>, context: RequestContext): Promise<T> {
    this.check(context);
    let onAbort: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => {
        try { this.check(context); } catch (error) { reject(error); }
      };
      this.controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const value = await Promise.race([operation(), cancelled]);
      this.check(context);
      return value;
    } finally { this.controller.signal.removeEventListener("abort", onAbort); }
  }
  async sleep(ms: number, context: RequestContext): Promise<void> {
    this.check(context);
    if (ms >= this.remaining) throw new StraylabsTimeoutError("The next attempt cannot fit within the operation deadline.", context);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await this.run(() => new Promise(resolve => { timer = setTimeout(resolve, ms); }), context); }
    finally { clearTimeout(timer); }
  }
  close(): void {
    clearTimeout(this.#timer);
    this.#caller?.removeEventListener("abort", this.#onAbort);
  }
}
