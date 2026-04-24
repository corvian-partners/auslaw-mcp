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
