import axios from "axios";
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
import { MAX_CONTENT_LENGTH } from "../constants.js";
import { assertFetchableUrl } from "../utils/url-guard.js";
import { austliiRateLimiter } from "../utils/rate-limiter.js";
import { logger } from "../utils/logger.js";

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
    const extractedText = textResult.text.trim();

    // If we got substantial text, return it
    if (extractedText.length > 100) {
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

  // Deduplicate by paragraph number — nested div/p matches can produce duplicates
  const seen = new Set<number>();
  return paragraphs.filter((b) => {
    if (seen.has(b.number)) return false;
    seen.add(b.number);
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
  // jade.io URLs are no longer supported — reject before the SSRF guard.
  if (url.includes("jade.io")) {
    throw new Error(
      "jade.io URLs are no longer supported. Use an AustLII URL or neutral citation instead.",
    );
  }

  // Normalise old /cgi-bin/viewdoc/ URL format (retired, returns 410) to the
  // current direct path format. e.g.:
  //   /cgi-bin/viewdoc/au/cases/nsw/NSWSC/2026/129.html → /au/cases/…
  url = url.replace(/^(https?:\/\/(?:www\.)?austlii\.edu\.au)\/cgi-bin\/viewdoc\//, "$1/");

  assertFetchableUrl(url);

  try {
    await austliiRateLimiter.throttle();

    // AustLII uses Vary: User-Agent and returns 410 for stale/bot-like UAs.
    // Include the same Sec-Fetch-* and client-hint headers a real Chrome
    // browser sends on a top-level navigation.
    const headers: Record<string, string> = {
      "User-Agent": config.austlii.userAgent,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
      "Accept-Language": "en-AU,en-GB;q=0.9,en;q=0.8",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-User": "?1",
      "sec-ch-ua": '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"macOS"',
    };

    const response = await axios.get(url, {
      responseType: "arraybuffer",
      headers,
      timeout: config.austlii.timeout,
      maxContentLength: MAX_CONTENT_LENGTH,
      // Disable automatic redirect following so the SSRF guard in assertFetchableUrl
      // cannot be bypassed by a 301/302 from AustLII pointing to a non-allowlisted host.
      maxRedirects: 0,
    });

    // Axios with maxRedirects:0 returns the redirect response rather than throwing.
    // Reject it explicitly so the SSRF guard cannot be bypassed by a redirect to
    // a non-allowlisted host.
    if (response.status >= 300 && response.status < 400) {
      throw new Error(`Redirect blocked: ${response.headers["location"] ?? "(no location)"}`);
    }

    const buffer = Buffer.from(response.data);
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
    if (axios.isAxiosError(error)) {
      throw new Error(`Failed to fetch document from ${url}: ${error.message}`);
    }
    throw error;
  }
}
