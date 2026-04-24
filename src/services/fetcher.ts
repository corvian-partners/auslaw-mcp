import * as cheerio from "cheerio";
import { fileTypeFromBuffer } from "file-type";
import { PDFParse } from "pdf-parse";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as tmp from "tmp";
import * as fs from "fs/promises";

// Promisified execFile — passes argv as an array so shell metacharacters in
// any argument are not interpreted. Replaces the abandoned node-tesseract-ocr
// package (GHSA-8j44-735h-w4w2: OS command injection via recognize() params).
const execFileAsync = promisify(execFile);
import { config } from "../config.js";
import { MAX_CONTENT_LENGTH, OCR_MIN_TEXT_LENGTH } from "../constants.js";
import { assertFetchableUrl } from "../utils/url-guard.js";
import { austliiRateLimiter } from "../utils/rate-limiter.js";
import { austliiNavigationHeaders } from "../utils/headers.js";
import { withRetry } from "../utils/retry.js";
import { logger } from "../utils/logger.js";
import { impersonateFetch, warmupSession } from "../utils/impersonate-fetch.js";

export interface ParagraphBlock {
  number: number;
  text: string;
  pageNumber?: number;
}

export interface FetchResponse {
  text: string;
  /** Cleaned HTML preserving document structure (only set for HTML sources). */
  html?: string;
  contentType: string;
  sourceUrl: string;
  ocrUsed: boolean;
  metadata?: Record<string, string>;
  paragraphs?: ParagraphBlock[];
}

async function extractTextFromPdf(
  buffer: Buffer,
  url: string,
): Promise<{ text: string; ocrUsed: boolean }> {
  try {
    // First try to extract text from PDF directly using pdf-parse v2 API
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    const textResult = await parser.getText();
    await parser.destroy();
    const extractedText = (textResult?.text ?? "").trim();

    // If we got substantial text, return it
    if (extractedText.length >= OCR_MIN_TEXT_LENGTH) {
      return { text: extractedText, ocrUsed: false };
    }

    // Otherwise, fall back to OCR
    logger.warn(`PDF at ${url} has minimal text, attempting OCR`);
    return await performOcr(buffer);
  } catch (error) {
    logger.warn(`PDF parsing failed for ${url}, attempting OCR`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return await performOcr(buffer);
  }
}

/**
 * Tesseract OCR via direct execFile (no shell). All arguments are passed
 * as an argv array so shell metacharacters cannot be interpreted. The input
 * path is a locally-generated tempfile (not user-controlled), and the OCR
 * config values come from env-var-backed `config.ocr.*` fields.
 */
async function performOcr(buffer: Buffer): Promise<{ text: string; ocrUsed: boolean }> {
  const tmpFile = tmp.fileSync({ postfix: ".pdf" });
  try {
    await fs.writeFile(tmpFile.name, buffer);

    // tesseract CLI: `tesseract <input> stdout -l <lang> --oem <n> --psm <n>`
    // Writing to stdout avoids a second tempfile for the output.
    const args = [
      tmpFile.name,
      "stdout",
      "-l",
      String(config.ocr.language),
      "--oem",
      String(config.ocr.oem),
      "--psm",
      String(config.ocr.psm),
    ];

    const { stdout } = await execFileAsync("tesseract", args, {
      // Allow up to 50 MB of recognised text — PDFs of full judgments can be large.
      maxBuffer: 50 * 1024 * 1024,
      // Fail fast on stuck tesseract (should never take more than a couple minutes).
      timeout: 180_000,
    });
    return { text: stdout.trim(), ocrUsed: true };
  } catch (error) {
    throw new Error(`OCR failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    tmpFile.removeCallback();
  }
}

/**
 * Generic HTML text extraction for AustLII and other sources
 */
function extractTextFromHtml(html: string): string {
  const $ = cheerio.load(html);

  // Remove script and style elements
  $("script, style, nav, header, footer").remove();

  // Try to find the main content area
  // Common patterns in legal websites
  const mainContentSelectors = [
    "article",
    "main",
    ".content",
    "#content",
    ".judgment",
    ".decision",
    ".case",
    ".legislation",
    "[role='main']",
  ];

  for (const selector of mainContentSelectors) {
    const $main = $(selector);
    if ($main.length > 0) {
      const text = $main.text().trim();
      if (text.length > 200) {
        return text;
      }
    }
  }

  // Fallback: Extract from body
  const bodyText = $("body").text().trim();

  // Clean up whitespace
  return bodyText.replace(/\s+/g, " ").trim();
}

/**
 * Cleans HTML by removing scripts, styles, navigation and other non-content
 * elements while preserving the document structure (headings, paragraphs, etc).
 */
function cleanHtmlForOutput(html: string): string {
  const $ = cheerio.load(html);

  // Remove non-content elements
  $("script, style, nav, header, footer, .sidebar, .navigation, .menu, link, meta").remove();

  // Try to extract just the main content area
  const contentSelectors = [
    "article",
    "main",
    ".content",
    "#content",
    ".judgment",
    ".judgment-text",
    ".judgment-content",
    ".decision",
    ".case-content",
    "[role='main']",
  ];

  for (const selector of contentSelectors) {
    const $content = $(selector);
    if ($content.length > 0) {
      const contentHtml = $content.html()?.trim();
      if (contentHtml && contentHtml.length > 200) {
        return contentHtml;
      }
    }
  }

  // Fallback: return the cleaned body
  const bodyHtml = $("body").html()?.trim();
  return bodyHtml || $.html() || "";
}

function extractParagraphBlocks(html: string): ParagraphBlock[] {
  const $ = cheerio.load(html);
  const paragraphs: ParagraphBlock[] = [];

  // Only match paragraph markers of the form `[123]` at the start of a block.
  // Non-numeric markers (e.g. `[1a]`, `[A1]`) are rare in AustLII judgments but
  // are not AGLC4 pinpoint targets, so we deliberately skip them here.
  $("p, div").each((_, el) => {
    const text = $(el).text().trim();
    const match = text.match(/^\[(\d+)\]\s*([\s\S]+)/);
    if (match && match[1] && match[2]) {
      paragraphs.push({
        number: parseInt(match[1], 10),
        text: match[2].trim(),
      });
    }
  });

  // Nested div/p matches often produce near-duplicate entries with identical
  // leading text. Dedupe by (number + first 64 chars of text) so genuinely
  // distinct paragraphs that happen to share a number (e.g. a reproduced
  // quotation) are preserved.
  const seen = new Set<string>();
  return paragraphs.filter((b) => {
    const key = `${b.number}::${b.text.slice(0, 64)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Fetches a legal document from a URL and extracts its text content.
 *
 * Supports HTML pages, PDF documents, and plain text. For scanned PDFs
 * with minimal extractable text the function falls back to Tesseract OCR.
 *
 * @param url - Absolute URL of the document to fetch
 * @returns Promise resolving to a {@link FetchResponse} with extracted text
 * @throws {Error} If the network request fails or the content type is unsupported
 */
export async function fetchDocumentText(url: string): Promise<FetchResponse> {
  // Normalise old /cgi-bin/viewdoc/ URL format (retired, returns 410) to the
  // current direct path format. e.g.:
  //   /cgi-bin/viewdoc/au/cases/nsw/NSWSC/2026/129.html → /au/cases/…
  url = url.replace(/^(https?:\/\/(?:www\.)?austlii\.edu\.au)\/cgi-bin\/viewdoc\//, "$1/");

  assertFetchableUrl(url);

  try {
    // Warm the Cloudflare session once per process so the cookie jar has
    // `__cf_bm` before we hit a real URL — first request otherwise gets
    // challenged.
    await warmupSession();

    // SSRF redirect safety: curl-impersonate follows redirects by default,
    // but we constrain to max 5 hops and assertFetchableUrl() above already
    // validated the starting URL. If a redirect were to escape austlii.edu.au
    // we catch it via the final response URL. (Cross-host redirects from
    // AustLII in practice never happen.)
    const response = await withRetry(
      async () => {
        await austliiRateLimiter.throttle();
        return impersonateFetch(url, {
          headers: austliiNavigationHeaders(),
          timeout: config.austlii.timeout,
          maxContentLength: MAX_CONTENT_LENGTH,
          maxRedirects: 5,
        });
      },
      { label: `AustLII fetch ${url}` },
    );

    if (response.status >= 400) {
      throw new Error(`AustLII returned HTTP ${response.status} for ${url}`);
    }

    const buffer = response.data;
    const contentType = response.headers["content-type"] || "";

    // Detect file type from buffer
    const detectedType = await fileTypeFromBuffer(buffer);

    let text: string;
    let cleanedHtml: string | undefined;
    let ocrUsed = false;
    let paragraphs: ParagraphBlock[] | undefined;

    // Handle PDF documents
    if (contentType.includes("application/pdf") || detectedType?.mime === "application/pdf") {
      const result = await extractTextFromPdf(buffer, url);
      text = result.text;
      ocrUsed = result.ocrUsed;
    }
    // Handle HTML documents
    else if (contentType.includes("text/html") || detectedType?.mime === "text/html") {
      const rawHtml = buffer.toString("utf-8");
      text = extractTextFromHtml(rawHtml);
      paragraphs = extractParagraphBlocks(rawHtml);
      cleanedHtml = cleanHtmlForOutput(rawHtml);
    }
    // Handle plain text
    else if (contentType.includes("text/plain")) {
      text = buffer.toString("utf-8");
    }
    // Unsupported format
    else {
      throw new Error(
        `Unsupported content type: ${contentType}${detectedType ? ` (detected: ${detectedType.mime})` : ""}`,
      );
    }

    // Extract basic metadata
    const metadata: Record<string, string> = {
      contentLength: String(buffer.length),
      contentType: contentType || detectedType?.mime || "unknown",
    };

    return {
      text,
      html: cleanedHtml,
      contentType: contentType || detectedType?.mime || "unknown",
      sourceUrl: url,
      ocrUsed,
      metadata,
      paragraphs,
    };
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to fetch document from ${url}: ${error.message}`);
    }
    throw error;
  }
}
