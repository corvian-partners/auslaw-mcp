import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { z } from "zod";
import {
  impersonateFetch,
  warmupSession,
  detectCloudflareChallenge,
} from "./utils/impersonate-fetch.js";
import * as cheerio from "cheerio";

import { formatFetchResponse, formatSearchResults } from "./utils/formatter.js";
import { fetchDocumentText } from "./services/fetcher.js";
import { assertFetchableUrl } from "./utils/url-guard.js";
import { searchAustLii, type SearchResult } from "./services/austlii.js";
import {
  formatAGLC4,
  validateCitation,
  parseCitation,
  generatePinpoint,
} from "./services/citation.js";
import { config } from "./config.js";
import { lawciteRateLimiter } from "./utils/rate-limiter.js";
import { lawciteHeaders } from "./utils/headers.js";
import { withRetry } from "./utils/retry.js";
import { logger } from "./utils/logger.js";
import { MAX_CONTENT_LENGTH } from "./constants.js";

const formatEnum = z.enum(["json", "text", "markdown", "html"]).default("json");
// Accept any AustLII jurisdiction or court code as a string.
// State/territory: cth, nsw, vic, qld, sa, wa, tas, nt, act, federal, nz, other
// Court-specific: hca, fca, fcafc, fcca, nswca, nswcca, nswsc, nswdc, nswlec,
//   vicca, vsc, qca, qsc, sasc, wasc, tassc, ntsc, actsc, and others.
const jurisdictionEnum = z.string().min(1);
const sortByEnum = z.enum(["relevance", "date", "auto"]).default("auto");
const caseMethodEnum = z
  .enum(["auto", "title", "phrase", "all", "any", "near", "boolean"])
  .default("auto");
const legislationMethodEnum = z
  .enum(["auto", "title", "phrase", "all", "any", "near", "legis", "boolean"])
  .default("auto");

/**
 * Build a fresh McpServer with all tools registered.
 *
 * In stateless HTTP mode (`sessionIdGenerator: undefined`), each request
 * requires its own server + transport instance because
 * `StreamableHTTPServerTransport` tracks per-request state on the Response
 * object. Reusing a single server/transport across requests throws
 * "Transport is already started" or silently corrupts the state machine.
 */
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "auslaw-mcp",
    version: "0.1.0",
    description: "Australian legislation and case law searcher with OCR-aware document retrieval.",
  });

  const searchLegislationShape = {
    query: z.string().min(1, "Query cannot be empty."),
    jurisdiction: jurisdictionEnum.optional(),
    limit: z.number().int().min(1).max(50).optional(),
    format: formatEnum.optional(),
    sortBy: sortByEnum.optional(),
    method: legislationMethodEnum.optional(),
    offset: z.number().int().min(0).max(500).optional(),
  };
  const searchLegislationParser = z.object(searchLegislationShape);

  server.registerTool(
    "auslaw_search_legislation",
    {
      title: "Search Legislation",
      description:
        "Search Australian and New Zealand legislation. Jurisdiction codes — state/territory: cth, nsw, vic, qld, sa, wa, tas, nt, act, federal, nz, other (omit for all). Methods: auto, title (titles only), phrase (exact match), all (all words), any (any word), near (proximity), legis (legislation names). Use offset for pagination.",
      inputSchema: searchLegislationShape,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (rawInput) => {
      const { query, jurisdiction, limit, format, sortBy, method, offset } =
        searchLegislationParser.parse(rawInput);
      const results = await searchAustLii(query, {
        type: "legislation",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        jurisdiction: jurisdiction as any,
        limit,
        sortBy,
        method,
        offset,
      });
      return formatSearchResults(results, format ?? "json");
    },
  );

  const searchCasesShape = {
    query: z.string().min(1, "Query cannot be empty."),
    jurisdiction: jurisdictionEnum.optional(),
    limit: z.number().int().min(1).max(50).optional(),
    format: formatEnum.optional(),
    sortBy: sortByEnum.optional(),
    method: caseMethodEnum.optional(),
    offset: z.number().int().min(0).max(500).optional(),
    fromYear: z
      .number()
      .int()
      .min(1900)
      .max(2100)
      .optional()
      .describe("Filter to cases decided on or after this year"),
    toYear: z
      .number()
      .int()
      .min(1900)
      .max(2100)
      .optional()
      .describe("Filter to cases decided on or before this year"),
  };
  const searchCasesParser = z.object(searchCasesShape);

  server.registerTool(
    "auslaw_search_cases",
    {
      title: "Search Cases",
      description:
        "Search Australian and New Zealand case law. Jurisdiction codes — state/territory: cth, nsw, vic, qld, sa, wa, tas, nt, act, federal, nz, other; court-specific: hca, fca, fcafc, fcca, nswca, nswcca, nswsc, nswdc, nswlec, vicca, vsc, qca, qsc, sasc, wasc, tassc, ntsc, actsc (omit for all). Methods: auto, title (case names only), phrase (exact match), all (all words), any (any word), near (proximity), boolean. Sorting: auto (smart detection), relevance, date. Use offset for pagination (e.g., offset=50 for page 2).",
      inputSchema: searchCasesShape,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (rawInput) => {
      const { query, jurisdiction, limit, format, sortBy, method, offset, fromYear, toYear } =
        searchCasesParser.parse(rawInput);

      let results = await searchAustLii(query, {
        type: "case",
        jurisdiction: jurisdiction as any,
        limit,
        sortBy,
        method,
        offset,
      });

      if (fromYear !== undefined || toYear !== undefined) {
        results = results.filter((r) => {
          const yr = parseInt(r.year ?? "0", 10);
          if (!yr) return true; // keep results with no year rather than discard
          if (fromYear !== undefined && yr < fromYear) return false;
          if (toYear !== undefined && yr > toYear) return false;
          return true;
        });
      }

      return formatSearchResults(results, format ?? "json");
    },
  );

  const fetchDocumentShape = {
    url: z.string().url("URL must be valid."),
    format: formatEnum.optional(),
  };
  const fetchDocumentParser = z.object(fetchDocumentShape);

  server.registerTool(
    "auslaw_fetch_document_text",
    {
      title: "Fetch Document Text",
      description:
        "Fetch full text for a legislation or case URL (AustLII), with OCR fallback for scanned PDFs.",
      inputSchema: fetchDocumentShape,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (rawInput) => {
      const { url, format } = fetchDocumentParser.parse(rawInput);
      const response = await fetchDocumentText(url);
      return formatFetchResponse(response, format ?? "json");
    },
  );

  // ── format_citation ──────────────────────────────────────────────────────
  const formatCitationShape = {
    title: z.string().min(1).describe("Case name, e.g. 'Mabo v Queensland (No 2)'"),
    neutralCitation: z.string().optional().describe("Neutral citation, e.g. '[1992] HCA 23'"),
    reportedCitation: z.string().optional().describe("Reported citation, e.g. '(1992) 175 CLR 1'"),
    pinpoint: z.string().optional().describe("Pinpoint reference, e.g. '[20]'"),
    style: z
      .enum(["neutral", "reported", "combined"])
      .default("combined")
      .describe(
        "Citation style: neutral (neutral only), reported (reported only), combined (both)",
      ),
    format: formatEnum.optional(),
  };
  const formatCitationParser = z.object(formatCitationShape);

  server.registerTool(
    "auslaw_format_citation",
    {
      title: "Format AGLC4 Citation",
      description:
        "Format an Australian case citation according to AGLC4 rules. Combines case name, neutral citation, reported citation, and optional pinpoint into the correct format.",
      inputSchema: formatCitationShape,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (rawInput) => {
      const { title, neutralCitation, reportedCitation, pinpoint, style, format } =
        formatCitationParser.parse(rawInput);

      const info = {
        title,
        neutralCitation: style !== "reported" ? neutralCitation : undefined,
        reportedCitation: style !== "neutral" ? reportedCitation : undefined,
        pinpoint,
      };
      const formatted = formatAGLC4(info);
      const fmt = format ?? "text";
      const payload = { citation: formatted, ...info };
      if (fmt === "json") {
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
        };
      }
      return { content: [{ type: "text" as const, text: formatted }] };
    },
  );

  // ── validate_citation ─────────────────────────────────────────────────────
  const validateCitationShape = {
    citation: z.string().min(1).describe("Neutral citation to validate, e.g. '[1992] HCA 23'"),
    format: formatEnum.optional(),
  };
  const validateCitationParser = z.object(validateCitationShape);

  server.registerTool(
    "auslaw_validate_citation",
    {
      title: "Validate Citation Against AustLII",
      description:
        "Validate a neutral citation by checking it exists on AustLII. Returns the canonical URL if valid.",
      inputSchema: validateCitationShape,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (rawInput) => {
      const { citation, format } = validateCitationParser.parse(rawInput);
      const result = await validateCitation(citation);
      const fmt = format ?? "json";
      if (fmt === "text" || fmt === "markdown") {
        const line = result.valid
          ? `Valid: ${result.canonicalCitation} → ${result.austliiUrl}`
          : `Invalid: ${result.message ?? "not found"}${result.austliiUrl ? ` (tried ${result.austliiUrl})` : ""}`;
        return { content: [{ type: "text" as const, text: line }] };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: { ...result } as Record<string, unknown>,
      };
    },
  );

  // ── generate_pinpoint ─────────────────────────────────────────────────────
  const generatePinpointShape = {
    url: z.string().url().describe("AustLII document URL to fetch and search"),
    paragraphNumber: z.number().int().positive().optional().describe("Paragraph number to locate"),
    phrase: z.string().min(1).optional().describe("Phrase to search for within paragraphs"),
    caseCitation: z
      .string()
      .optional()
      .describe("Case citation to prepend to the pinpoint, e.g. '[2022] FedCFamC2F 786'"),
    format: formatEnum.optional(),
  };
  const generatePinpointParser = z
    .object(generatePinpointShape)
    .refine(
      (d) => d.paragraphNumber !== undefined || d.phrase !== undefined,
      "Provide at least one of paragraphNumber or phrase",
    );

  server.registerTool(
    "auslaw_generate_pinpoint",
    {
      title: "Generate Pinpoint Citation",
      description:
        "Fetch a judgment from AustLII and generate a pinpoint citation to a specific paragraph (by number or by searching for a phrase).",
      inputSchema: generatePinpointShape,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (rawInput) => {
      const { url, paragraphNumber, phrase, caseCitation, format } =
        generatePinpointParser.parse(rawInput);
      const fmt = format ?? "json";
      const respond = (payload: Record<string, unknown>, isError = false) => {
        if (fmt === "text" || fmt === "markdown") {
          if (isError) {
            return {
              content: [{ type: "text" as const, text: String(payload["error"] ?? "error") }],
              isError: true,
            };
          }
          return {
            content: [
              {
                type: "text" as const,
                text: String(payload["fullCitation"] ?? payload["pinpointString"] ?? ""),
              },
            ],
          };
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
          ...(isError ? { isError: true } : {}),
        };
      };

      const doc = await fetchDocumentText(url);
      if (!doc.paragraphs || doc.paragraphs.length === 0) {
        return respond({ error: "No paragraph blocks found in document" }, true);
      }
      const pinpoint = generatePinpoint(doc.paragraphs, { paragraphNumber, phrase });
      if (!pinpoint) {
        return respond({ error: "Paragraph not found" }, true);
      }
      const fullCitation = caseCitation
        ? `${caseCitation} ${pinpoint.pinpointString}`
        : pinpoint.pinpointString;
      return respond({ ...pinpoint, fullCitation });
    },
  );

  // ── search_by_citation ────────────────────────────────────────────────────
  const searchByCitationShape = {
    citation: z
      .string()
      .min(1)
      .describe("Citation to search for, e.g. '[1992] HCA 23' or 'Mabo v Queensland'"),
    format: formatEnum.optional(),
  };
  const searchByCitationParser = z.object(searchByCitationShape);

  server.registerTool(
    "auslaw_search_by_citation",
    {
      title: "Search by Citation",
      description:
        "Find a case by its citation. If a neutral citation is detected, validates it against AustLII and returns the direct URL. Otherwise performs a case name search.",
      inputSchema: searchByCitationShape,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (rawInput) => {
      const { citation, format } = searchByCitationParser.parse(rawInput);
      const parsed = parseCitation(citation);

      if (parsed?.neutralCitation) {
        const validated = await validateCitation(parsed.neutralCitation);
        if (validated.valid && validated.austliiUrl) {
          const result: SearchResult = {
            title: citation,
            neutralCitation: parsed.neutralCitation,
            url: validated.austliiUrl,
            source: "austlii",
            type: "case",
          };
          return formatSearchResults([result], format ?? "json");
        }
      }

      // Fall back to text search
      const results = await searchAustLii(citation, {
        type: "case",
        sortBy: "relevance",
        limit: 5,
      });
      return formatSearchResults(results, format ?? "json");
    },
  );

  // ── search_citing_cases ───────────────────────────────────────────────────
  const searchCitingCasesShape = {
    citation: z
      .string()
      .min(1)
      .describe(
        "Neutral citation or case name to find citing cases for, e.g. '[1992] HCA 23' or 'Mabo v Queensland (No 2)'",
      ),
    format: formatEnum.optional(),
  };
  const searchCitingCasesParser = z.object(searchCitingCasesShape);

  server.registerTool(
    "auslaw_search_citing_cases",
    {
      title: "Search Citing Cases (Citator)",
      description:
        "Find cases that cite a given case. Uses LawCite (AustLII's citator service) to find citing cases. Returns citing cases with case names, AustLII URLs, neutral citations, and court/date information where available.",
      inputSchema: searchCitingCasesShape,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (rawInput) => {
      const { citation, format } = searchCitingCasesParser.parse(rawInput);

      interface CitingCaseResult {
        title: string;
        citation?: string;
        url: string;
        excerpt?: string;
        court?: string;
        date?: string;
      }

      async function searchLawCite(cit: string): Promise<CitingCaseResult[]> {
        const lawciteUrl = `${config.lawcite.baseUrl}?cit=${encodeURIComponent(cit)}&nolinks=1`;
        await warmupSession();
        const response = await withRetry(
          async () => {
            await lawciteRateLimiter.throttle();
            return impersonateFetch(lawciteUrl, {
              headers: lawciteHeaders(),
              timeout: config.lawcite.timeout,
            });
          },
          { label: "LawCite lookup" },
        );

        const $ = cheerio.load(response.data.toString("utf8"));
        const results: CitingCaseResult[] = [];

        // LawCite results: links to austlii.edu.au cases within the body
        $("a[href*='austlii.edu.au']").each((_, el) => {
          const href = $(el).attr("href") || "";
          // Only include case URLs (not search links etc.)
          if (!href.includes("/cases/")) return;

          const title = $(el).text().trim();
          if (!title) return;

          // Extract neutral citation from surrounding text
          const parentText = $(el).parent().text();
          const citationMatch = parentText.match(/\[(\d{4})\]\s+([A-Z]+(?:\s+[A-Z]+)?)\s+(\d+)/);
          const neutralCitation = citationMatch ? citationMatch[0] : undefined;

          // Ensure absolute URL
          const url = href.startsWith("http") ? href : `https://www.austlii.edu.au${href}`;

          // Avoid duplicates by URL
          if (results.some((r) => r.url === url)) return;

          results.push({
            title,
            citation: neutralCitation,
            url,
          });
        });

        return results;
      }

      let citingCases: CitingCaseResult[] = [];

      try {
        citingCases = await searchLawCite(citation);
      } catch (err) {
        logger.warn("LawCite lookup failed, falling back to AustLII phrase search", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Fall back to AustLII phrase search if LawCite returned nothing
      if (citingCases.length === 0) {
        const fallbackResults = await searchAustLii(citation, {
          type: "case",
          method: "phrase",
          limit: 20,
        });
        citingCases = fallbackResults.map((r) => ({
          title: r.title,
          citation: r.neutralCitation,
          url: r.url,
          excerpt: r.summary,
          court: undefined,
          date: undefined,
        }));
      }

      const totalCount = citingCases.length;
      const output = { totalCount, results: citingCases };
      const fmt = format ?? "json";

      if (fmt === "json") {
        return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }] };
      }

      // Markdown/text fallback
      const lines = [
        `**${totalCount} citing cases found**`,
        "",
        ...citingCases.map(
          (r) =>
            `- ${r.title}${r.citation ? " " + r.citation : ""}${r.court ? " — " + r.court : ""} — ${r.url}`,
        ),
      ];
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  // ── fetch_legislation_section ─────────────────────────────────────────────
  server.registerTool(
    "auslaw_fetch_legislation_section",
    {
      title: "Fetch Legislation Section",
      description:
        "Fetch the text of a specific section or schedule from an Australian Act on AustLII. " +
        "More efficient than auslaw_fetch_document_text on the whole Act when you only need one provision. " +
        "Accepts the Act's AustLII URL and a section reference like '18', 's 18', 'section 18', 'schedule 1'.",
      inputSchema: {
        url: z
          .string()
          .url()
          .describe(
            "AustLII URL of the Act, e.g. 'https://www.austlii.edu.au/au/legis/cth/consol_act/cca2010265/'",
          ),
        section: z
          .string()
          .min(1)
          .describe("Section reference, e.g. '18', 's 18', 'section 18A', 'schedule 1', 'sch 2'"),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (rawInput) => {
      const { url, section } = z
        .object({
          url: z.string().url(),
          section: z.string().min(1),
        })
        .parse(rawInput);

      // Normalise section reference to AustLII path segment
      const norm = section
        .trim()
        .toLowerCase()
        .replace(/^section\s+/, "s")
        .replace(/^schedule\s+/, "sch")
        .replace(/^sch\s+/, "sch")
        .replace(/^s\s+/, "s")
        .replace(/\s+/g, "")
        // Bare number like "18" or "18a" → "s18" / "s18a"
        .replace(/^(\d+[a-z]?)$/, "s$1");

      // Validate the normalised segment looks like s18, s18a, sch1 etc.
      if (!/^(s\d+[a-z]?|sch\d+[a-z]?)$/i.test(norm)) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "invalid_section",
                message: `Could not parse section reference "${section}". Use formats like "18", "s 18", "18A", "schedule 1".`,
              }),
            },
          ],
          isError: true,
        };
      }

      const baseUrl = url.replace(/\/+$/, "");
      const sectionUrl = `${baseUrl}/${norm}.html`;

      try {
        assertFetchableUrl(sectionUrl);
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "invalid_url",
                message: "Only AustLII URLs are supported.",
              }),
            },
          ],
          isError: true,
        };
      }

      let doc;
      try {
        doc = await fetchDocumentText(sectionUrl);
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "fetch_failed",
                message: `Could not retrieve section ${section}. The section may not exist at this URL, or AustLII may be temporarily unavailable.`,
                detail: err instanceof Error ? err.message : String(err),
              }),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              act_url: url,
              section_url: sectionUrl,
              section_ref: section,
              text: doc.text,
            }),
          },
        ],
      };
    },
  );

  return server;
}

// Maximum accepted request body size — prevents OOM on the private network.
// Legitimate MCP JSON-RPC messages are never remotely close to this limit.
const MAX_REQUEST_BODY = Math.min(MAX_CONTENT_LENGTH, 1 * 1024 * 1024); // 1 MB

interface DependencyProbe {
  status: "ok" | "error" | "missing";
  latencyMs?: number;
  detail?: string;
}

/**
 * One-shot startup check that fetches the AustLII homepage and reports whether
 * the TLS/JA4 bypass is actually working. Never blocks startup — pure logging.
 */
async function verifyBypassOnStartup(): Promise<void> {
  try {
    const r = await impersonateFetch("https://www.austlii.edu.au/", {
      timeout: 10_000,
      headers: { "User-Agent": config.austlii.userAgent },
    });
    const challenge = detectCloudflareChallenge(r);
    if (r.status === 200 && !challenge) {
      logger.info("AustLII startup probe: JA4 bypass OK", { status: r.status });
    } else {
      logger.error(
        "AustLII startup probe: bypass NOT working — tools will fail with 403/challenge. Check curl-impersonate binary in container.",
        { status: r.status, challenge: challenge ?? "none" },
      );
    }
  } catch (err) {
    logger.error("AustLII startup probe: fetch failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function probeAustLii(): Promise<DependencyProbe> {
  const start = Date.now();
  try {
    const r = await impersonateFetch(config.austlii.baseUrl, {
      method: "HEAD",
      timeout: 5000,
      headers: { "User-Agent": config.austlii.userAgent },
    });
    if (r.status >= 400) {
      return { status: "error", detail: `HTTP ${r.status}`, latencyMs: Date.now() - start };
    }
    return { status: "ok", latencyMs: Date.now() - start };
  } catch (err) {
    return { status: "error", detail: err instanceof Error ? err.message : String(err) };
  }
}

async function probeTesseract(): Promise<DependencyProbe> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync("tesseract", ["--version"], { timeout: 3000 });
    const version = stdout.split("\n")[0]?.trim();
    return { status: "ok", detail: version };
  } catch {
    return { status: "missing", detail: "tesseract not available on PATH" };
  }
}

async function main() {
  if (process.env.MCP_TRANSPORT === "http") {
    const port = parseInt(process.env.PORT ?? "3000", 10);

    const httpServer = createServer(async (req, res) => {
      if (req.url === "/health" || req.url?.startsWith("/health?")) {
        const deep = req.url.includes("deep=1");
        const health: Record<string, unknown> = {
          status: "ok",
          service: "auslaw-mcp",
          timestamp: new Date().toISOString(),
        };
        if (deep) {
          const [austlii, tesseract] = await Promise.all([probeAustLii(), probeTesseract()]);
          health["dependencies"] = { austlii, tesseract };
          if (austlii.status !== "ok") health["status"] = "degraded";
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(health));
        return;
      }
      // Per-request server + transport (required for stateless streamable HTTP).
      // The SDK's StreamableHTTPServerTransport mutates the Response object and
      // cannot be reused across requests when sessionIdGenerator is undefined.
      const mcpServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on("close", () => {
        // Fire-and-forget cleanup; errors here are non-fatal.
        void transport.close().catch(() => {});
        void mcpServer.close().catch(() => {});
      });
      try {
        await mcpServer.connect(transport);

        // Accumulate body with size guard — reject oversized payloads early.
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        for await (const chunk of req) {
          totalBytes += (chunk as Buffer).length;
          if (totalBytes > MAX_REQUEST_BODY) {
            res.writeHead(413, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Request body too large" }));
            return;
          }
          chunks.push(chunk as Buffer);
        }

        const bodyStr = Buffer.concat(chunks).toString();
        let body: Record<string, unknown> | undefined;
        if (bodyStr) {
          try {
            body = JSON.parse(bodyStr) as Record<string, unknown>;
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid JSON in request body" }));
            return;
          }
        }
        await transport.handleRequest(req, res, body);
      } catch (err) {
        logger.error(
          "auslaw-mcp request error",
          err instanceof Error ? err : new Error(String(err)),
        );
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : "Internal server error",
            }),
          );
        }
      }
    });

    httpServer.listen(port, () => {
      logger.info(`auslaw-mcp HTTP transport listening on :${port}`);
      // Fire-and-forget JA4 bypass verification. Logs loudly if curl-impersonate
      // is missing or the AustLII fetch fails — saves 30 min of head-scratching
      // when a container image upgrade drops the binary.
      void verifyBypassOnStartup();
    });

    // Graceful shutdown — Railway sends SIGTERM before replacing the container.
    process.on("SIGTERM", () => {
      logger.info("SIGTERM received, shutting down gracefully");
      httpServer.close(() => process.exit(0));
    });
  } else {
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);

    // Graceful shutdown for stdio mode — ensures in-flight tool calls complete
    // before the process exits. Mirrors the HTTP-mode SIGTERM handler above.
    process.on("SIGTERM", () => {
      logger.info("SIGTERM received (stdio mode), shutting down gracefully");
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
      process.exit(0);
    });
  }
}

main().catch((error) => {
  logger.error("Fatal server error", error instanceof Error ? error : new Error(String(error)));
  process.exit(1);
});
