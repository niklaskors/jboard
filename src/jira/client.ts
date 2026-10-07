// HTTP access to Jira: bearer token, retries, an error log and SSO re-sign-in.

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { openUrl } from "../browser.ts";
import { SERVER, SSO_URL, TOKEN } from "../config.ts";

const RETRY_CODES = new Set([403, 429, 502, 503, 504]); // 403 included: some proxies/WAFs return it intermittently
const ATTEMPTS = 3;
const ERROR_LOG = join(homedir(), ".cache", "jboard", "errors.log");
const DIAG_HEADERS = ["X-Seraph-LoginReason", "X-Authentication-Denied-Reason", "X-AUSERNAME",
  "Retry-After", "Server", "Via", "X-Cache"];
const SIGN_IN_WAIT_MS = 30_000;
const SIGN_IN_POLL_MS = 2_000;

/** Anything that went wrong talking to Jira, with a message meant for the user. */
export class JiraError extends Error {}

export type Params = Record<string, string | number>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function logError(res: Response, body: string, url: string, attempt: number): void {
  try {
    mkdirSync(dirname(ERROR_LOG), { recursive: true });
    const headers = [...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n");
    const stamp = new Date().toLocaleString("sv-SE"); // 2026-10-01 09:33:24
    appendFileSync(ERROR_LOG,
      `--- ${stamp} attempt ${attempt}/${ATTEMPTS} HTTP ${res.status} ${url}\n${headers}\n\n${body.slice(0, 500)}\n\n`);
  } catch {
    // logging is best effort
  }
}

let reportSignIn = (message: string) => console.error(`jboard: ${message}`);
let signIn: Promise<boolean> | null = null;

/** Where sign-in progress is reported; the interactive board shows it in its status line. */
export function onSignInProgress(report: (message: string) => void): void {
  reportSignIn = report;
}

/**
 * Redo the SSO sign-in by opening Jira's login page (the config's ssoUrl) in the background browser,
 * then wait until the token is accepted again. Requests failing at the same time share one attempt.
 */
function refreshSignIn(): Promise<boolean> {
  signIn ??= (async () => {
    reportSignIn("refreshing your Jira sign-in in the browser…");
    openUrl(SSO_URL, { background: true });
    for (const deadline = Date.now() + SIGN_IN_WAIT_MS; Date.now() < deadline;) {
      await sleep(SIGN_IN_POLL_MS);
      const probe = await fetch(`${SERVER}/rest/api/2/myself`, {
        headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" }, signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
      if (probe?.ok) {
        reportSignIn("signed in again");
        return true;
      }
    }
    return false;
  })().finally(() => {
    signIn = null; // a later expiry gets its own attempt
  });
  return signIn;
}

/** Jira's own explanation from an error body, e.g. "User 'x' cannot be assigned issues." */
export function jiraMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { errorMessages?: string[]; errors?: Record<string, string> };
    return [...(parsed.errorMessages ?? []), ...Object.values(parsed.errors ?? {})].join("; ");
  } catch {
    return "";
  }
}

export async function request<T>(method: "GET" | "PUT" | "POST", path: string,
  opts: { params?: Params; body?: unknown } = {}): Promise<T> {
  const query = new URLSearchParams(Object.entries(opts.params ?? {}).map(([k, v]) => [k, String(v)])).toString();
  const url = `${SERVER}${path}${query ? `?${query}` : ""}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  let signedInAgain = false;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      throw new JiraError(`cannot reach Jira: ${cause?.code ?? cause?.message ?? (e as Error).message}`);
    }
    if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T;

    const body = await res.text().catch(() => "");
    logError(res, body, `${method} ${url}`, attempt);
    // Jira with SAML SSO can refuse a valid token (user known, yet a "sufficient permissions" 403) until
    // the sign-in is redone in the browser; Jira refused before acting, so repeating is safe
    const user = decodeURIComponent(res.headers.get("x-ausername") ?? "");
    if (res.status === 403 && user && user !== "anonymous" && body.includes("sufficient permissions")) {
      if (!signedInAgain && await refreshSignIn()) {
        signedInAgain = true;
        attempt = 0; // the loop's attempt++ makes this a fresh first attempt
        continue;
      }
      throw new JiraError("Jira still refuses your token: finish signing in in the Jira browser tab, then try again");
    }
    // a 403 on a write is a real permission error, so only reads retry it
    const retryable = RETRY_CODES.has(res.status) && (method === "GET" || res.status !== 403);
    if (retryable && attempt < ATTEMPTS) {
      const retryAfter = res.headers.get("retry-after") ?? "";
      await sleep(/^\d+$/.test(retryAfter) ? Math.min(10, Number(retryAfter)) * 1000 : 1500 * attempt);
      continue;
    }
    const message = jiraMessage(body);
    const diag = DIAG_HEADERS.filter((h) => res.headers.get(h)).map((h) => `${h}: ${res.headers.get(h)}`);
    throw new JiraError(`HTTP ${res.status} on ${method} ${path} after ${attempt} attempt(s)`
      + (message ? `: ${message}` : "") + (diag.length ? ` (${diag.join(", ")})` : "") + ` - details in ${ERROR_LOG}`);
  }
}

export const get = <T>(path: string, params: Params = {}) => request<T>("GET", path, { params });
