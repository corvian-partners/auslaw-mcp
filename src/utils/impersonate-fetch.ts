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
import { mkdtempSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);

// Binary name is configurable so the Dockerfile can pin a specific Chrome
// profile (e.g. curl_chrome124). Falls back to a reasonable default.
const CURL_BIN = process.env.CURL_IMPERSONATE_BIN ?? "curl_chrome124";

// Per-process cookie jar file. curl reads/writes Netscape-format cookies
// here; this preserves `__cf_bm` across requests within the lifetime of
// this process.
const COOKIE_DIR = mkdtempSync(join(tmpdir(), "auslaw-ci-"));
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

  // Write body to a tempfile so we never expose it on the command line
  // (curl's --data-binary @file reads straight from disk).
  let bodyFile: string | null = null;
  const args: string[] = [
    "--silent",
    "--show-error",
    "--compressed",
    "--http2",
    "--max-time",
    String(Math.ceil(timeoutMs / 1000)),
    "--max-redirs",
    String(maxRedirects),
    "--max-filesize",
    String(maxBytes),
    // Cookie jar: read existing cookies and write back any new ones.
    "--cookie",
    COOKIE_JAR,
    "--cookie-jar",
    COOKIE_JAR,
    // -D writes response headers to stdout alongside the body; we separate
    // them with a custom marker below.
    "--write-out",
    "__HTTP_STATUS__:%{http_code}\\n",
  ];

  if (method === "HEAD") {
    // -X HEAD keeps our stdout/stderr split (body→stdout, headers→stderr);
    // --head would redirect headers to stdout and break our parser.
    args.push("--request", "HEAD");
  } else if (method === "POST") {
    if (options.body) {
      const encoded =
        typeof options.body === "string"
          ? options.body
          : new URLSearchParams(options.body).toString();
      bodyFile = join(COOKIE_DIR, `body-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

  // Dump response headers to stderr so we can parse them without mangling
  // the body (which may be binary — PDFs).
  args.push("--dump-header", "/dev/stderr");
  args.push("--output", "-"); // body to stdout
  args.push(url);

  try {
    const { stdout, stderr } = await execFileAsync(CURL_BIN, args, {
      encoding: "buffer",
      maxBuffer: maxBytes + 64 * 1024,
      timeout: timeoutMs + 5_000,
    });

    // Split status line + headers from stderr. curl writes one block per
    // hop on redirect; we want the last block only.
    const headerBlocks = stderr
      .toString("utf8")
      .split(/\r?\n\r?\n/)
      .filter((b) => b.trim());
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

    // Strip the --write-out suffix that we appended to stdout.
    const bodyBuf = Buffer.from(stdout);
    const marker = Buffer.from("__HTTP_STATUS__:");
    const markerIdx = bodyBuf.lastIndexOf(marker);
    const data = markerIdx >= 0 ? bodyBuf.subarray(0, markerIdx) : bodyBuf;

    return { status, statusText, headers, data };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("impersonateFetch failed", { url, error: msg });
    throw new Error(`impersonate fetch failed for ${url}: ${msg}`);
  } finally {
    if (bodyFile && existsSync(bodyFile)) {
      try {
        unlinkSync(bodyFile);
      } catch {
        // best-effort cleanup
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
