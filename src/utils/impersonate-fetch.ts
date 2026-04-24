/**
 * TLS-impersonating HTTP client for AustLII.
 *
 * AustLII fronts its origin with Cloudflare, which gates non-browser clients
 * via TLS/JA4 fingerprint + JS challenge. Node's `fetch`/axios use OpenSSL
 * with a Node-specific ClientHello that Cloudflare flags immediately
 * (`cf-mitigated: challenge`, HTTP 403). We shell out to the `curl-impersonate`
 * binary (Chrome TLS profile) which replicates a real browser's handshake.
 *
 * A shared cookie jar persists Cloudflare's `__cf_bm` bot-management cookie
 * across requests — first request warms the session, subsequent requests
 * present the cookie and pass through without challenge.
 *
 * Note: this bypasses the TLS/bot-fingerprint layer only. Cloudflare may
 * still challenge specific paths (e.g. `/cgi-bin/sinosrch.cgi`) with a full
 * JS challenge that no HTTP client can solve without a real browser.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);

// Binary name is configurable so the Dockerfile can pin a specific Chrome
// profile (e.g. curl_chrome124). Falls back to a reasonable default.
const CURL_BIN = process.env.CURL_IMPERSONATE_BIN ?? "curl_chrome124";

// If the binary isn't on PATH (local dev, CI without Docker), fall through
// to Node's fetch. Production runs in the Docker image which ships the
// lexiforest musl build, so this fallback only fires in dev/test.
let _curlAvailable: boolean | null = null;
async function curlAvailable(): Promise<boolean> {
  if (_curlAvailable !== null) return _curlAvailable;
  try {
    await execFileAsync(CURL_BIN, ["--version"], { timeout: 5_000 });
    _curlAvailable = true;
  } catch {
    _curlAvailable = false;
    logger.warn(
      `curl-impersonate binary (${CURL_BIN}) not found — falling back to Node fetch. AustLII will 403 in production without this binary.`,
    );
  }
  return _curlAvailable;
}

async function fetchFallback(
  url: string,
  options: ImpersonateOptions,
): Promise<ImpersonateResponse> {
  const method = options.method ?? "GET";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout ?? 30_000);
  try {
    const body =
      method === "POST" && options.body
        ? typeof options.body === "string"
          ? options.body
          : new URLSearchParams(options.body).toString()
        : undefined;
    const res = await fetch(url, {
      method,
      headers: options.headers,
      body,
      redirect: "follow",
      signal: controller.signal,
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, statusText: res.statusText, headers, data: buf };
  } finally {
    clearTimeout(timer);
  }
}

// Per-process cookie jar file. curl reads/writes Netscape-format cookies
// here; this preserves `__cf_bm` across requests within the lifetime of
// this process. Create as world-writable (0700 is fine since mkdtempSync
// returns a dir owned by the current uid, but we ensure write perm
// explicitly for defence against odd container umasks).
const COOKIE_DIR = mkdtempSync(join(tmpdir(), "auslaw-ci-"));
try {
  chmodSync(COOKIE_DIR, 0o700);
} catch {
  // best-effort — if chmod isn't allowed, mkdtempSync's default is fine.
}
const COOKIE_JAR = join(COOKIE_DIR, "cookies.txt");

export interface ImpersonateResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** Raw body as a Buffer (so PDF fetches work). */
  data: Buffer;
}

/**
 * Thrown when Cloudflare presents a JS challenge or managed challenge that no
 * HTTP client (including TLS-impersonated curl) can solve. Call sites should
 * translate this into a user-facing message rather than an empty result.
 */
export class CloudflareChallengeError extends Error {
  constructor(
    public readonly url: string,
    public readonly marker: string,
  ) {
    super(`Cloudflare challenge page served for ${url} (marker: ${marker})`);
    this.name = "CloudflareChallengeError";
  }
}

/**
 * Heuristic detector for CF challenge / managed-challenge interstitials.
 * Returns a non-null marker string when the response looks like a challenge,
 * otherwise null. Only inspected for 2xx HTML responses — non-2xx status codes
 * are handled by the caller's status check.
 */
export function detectCloudflareChallenge(res: ImpersonateResponse): string | null {
  if (res.headers["cf-mitigated"] === "challenge") return "cf-mitigated:challenge";
  const ct = res.headers["content-type"] ?? "";
  if (!ct.includes("text/html")) return null;
  // Only peek at first ~4KB — challenge pages declare themselves early.
  const head = res.data.subarray(0, 4096).toString("utf8");
  if (/<title>\s*Just a moment/i.test(head)) return "title:just-a-moment";
  if (/challenge-platform|cf_chl_opt|__cf_chl_rt_tk/.test(head)) return "body:challenge-platform";
  if (/Attention Required!.*Cloudflare/is.test(head)) return "body:attention-required";
  return null;
}

interface ImpersonateOptions {
  method?: "GET" | "HEAD" | "POST";
  headers?: Record<string, string>;
  /** Request body for POST. Serialised with x-www-form-urlencoded if an object. */
  body?: string | Record<string, string>;
  /** Request timeout in milliseconds. Default 30s. */
  timeout?: number;
  /** Max response size in bytes. Default 50 MB. */
  maxContentLength?: number;
  /** Maximum redirect hops. Default 5. */
  maxRedirects?: number;
}

/**
 * Fetch a URL using curl-impersonate. Response shape mirrors axios's minimum
 * useful surface so call sites can migrate with minimal churn.
 */
export async function impersonateFetch(
  url: string,
  options: ImpersonateOptions = {},
): Promise<ImpersonateResponse> {
  if (!(await curlAvailable())) return fetchFallback(url, options);

  const method = options.method ?? "GET";
  const timeoutMs = options.timeout ?? 30_000;
  const maxBytes = options.maxContentLength ?? 50 * 1024 * 1024;
  const maxRedirects = options.maxRedirects ?? 5;

  // Tempfiles for request body (if POST), response body, and response headers.
  // Writing to tempfiles rather than stdout/stderr avoids curl exit code 23
  // ("failed writing received data") that occurred on Railway when
  // /dev/stderr wasn't writable in the exec environment.
  const reqId = randomBytes(8).toString("hex");
  const outFile = join(COOKIE_DIR, `out-${reqId}`);
  const headFile = join(COOKIE_DIR, `hdr-${reqId}`);
  let bodyFile: string | null = null;

  const args: string[] = [
    "--silent",
    "--show-error",
    "--compressed",
    "--http2",
    "--location",
    "--max-time",
    String(Math.ceil(timeoutMs / 1000)),
    "--max-redirs",
    String(maxRedirects),
    "--max-filesize",
    String(maxBytes),
    "--cookie",
    COOKIE_JAR,
    "--cookie-jar",
    COOKIE_JAR,
    "--output",
    outFile,
    "--dump-header",
    headFile,
  ];

  if (method === "HEAD") {
    // -X HEAD keeps the output shape consistent with GET.
    args.push("--request", "HEAD");
  } else if (method === "POST") {
    if (options.body) {
      const encoded =
        typeof options.body === "string"
          ? options.body
          : new URLSearchParams(options.body).toString();
      bodyFile = join(COOKIE_DIR, `body-${reqId}`);
      writeFileSync(bodyFile, encoded);
      args.push("--data-binary", `@${bodyFile}`);
    }
  }

  // Caller-supplied headers (User-Agent, Referer, etc.). curl-impersonate's
  // Chrome profile supplies the browser-fingerprint headers itself; these
  // are additive.
  for (const [k, v] of Object.entries(options.headers ?? {})) {
    args.push("-H", `${k}: ${v}`);
  }

  args.push(url);

  try {
    await execFileAsync(CURL_BIN, args, {
      // We only care that curl exits 0; all real output is in tempfiles.
      maxBuffer: 256 * 1024,
      timeout: timeoutMs + 5_000,
    });
  } catch (err: unknown) {
    // Clean up any tempfiles curl may have created before we rethrow.
    for (const f of [outFile, headFile, bodyFile].filter(Boolean) as string[]) {
      if (existsSync(f)) {
        try {
          unlinkSync(f);
        } catch {
          /* best-effort */
        }
      }
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("impersonateFetch failed", { url, error: msg });
    throw new Error(`impersonate fetch failed for ${url}: ${msg}`);
  }

  try {
    const headerText = existsSync(headFile) ? readFileSync(headFile, "utf8") : "";
    const data = existsSync(outFile) ? readFileSync(outFile) : Buffer.alloc(0);

    // curl writes one header block per hop on redirects; take the last.
    const headerBlocks = headerText.split(/\r?\n\r?\n/).filter((b) => b.trim());
    const lastBlock = headerBlocks[headerBlocks.length - 1] ?? "";
    const headerLines = lastBlock.split(/\r?\n/);
    const statusLine = headerLines[0] ?? "";
    const statusMatch = statusLine.match(/^HTTP\/[\d.]+\s+(\d+)\s*(.*)$/);
    const status = statusMatch ? parseInt(statusMatch[1]!, 10) : 0;
    const statusText = statusMatch?.[2]?.trim() ?? "";

    const headers: Record<string, string> = {};
    for (const line of headerLines.slice(1)) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const name = line.slice(0, idx).trim().toLowerCase();
      const value = line.slice(idx + 1).trim();
      if (name) headers[name] = value;
    }

    return { status, statusText, headers, data };
  } finally {
    for (const f of [outFile, headFile, bodyFile].filter(Boolean) as string[]) {
      if (existsSync(f)) {
        try {
          unlinkSync(f);
        } catch {
          /* best-effort */
        }
      }
    }
  }
}

/** One-time warmup: fetch the AustLII root so the cookie jar picks up `__cf_bm`. */
let warmupPromise: Promise<void> | null = null;
export function warmupSession(): Promise<void> {
  if (!warmupPromise) {
    warmupPromise = (async () => {
      try {
        await impersonateFetch("https://www.austlii.edu.au/", { timeout: 15_000 });
      } catch (err) {
        logger.warn("AustLII session warmup failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }
  return warmupPromise;
}

/** Read the current cookie jar (for debugging/diagnostics). */
export function getCookieJarContents(): string {
  try {
    return readFileSync(COOKIE_JAR, "utf8");
  } catch {
    return "";
  }
}
