#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { z } from "zod";
import axios from "axios";
import * as cheerio from "cheerio";

import path from "node:path";
import { formatFetchResponse, formatSearchResults } from "./utils/formatter.js";
import { fetchDocumentText } from "./services/fetcher.js";
import { assertFetchableUrl } from "./utils/url-guard.js";
import { searchAustLii, type SearchResult } from "./services/austlii.js";
import {
  formatAGLC4,
  formatShortForm,
  validateCitation,
  parseCitation,
  generatePinpoint,
  normaliseCitation,
} from "./services/citation.js";
import { config } from "./config.js";
import { lawciteRateLimiter } from "./utils/rate-limiter.js";
import { lawciteHeaders } from "./utils/headers.js";
import { withRetry } from "./utils/retry.js";
import { logger } from "./utils/logger.js";
import {
  MAX_CONTENT_LENGTH,
  NEUTRAL_CITATION_PATTERN,
  COURT_TO_AUSTLII_PATH,
  AUSLAW_CACHE_DIR_NAME,
} from "./constants.js";
import {
  upsertCitation,
  getCitation,
  listCitations,
  exportBib,
  updateSourceFields,
  updateCitedBy,
  updateCitedBySource,
  type CitedByRef,
} from "./services/citation-cache.js";
import { storeSource, checkSourceFreshness } from "./services/source-store.js";

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
 * Derive an AustLII URL from a neutral citation without a network call.
 * Returns undefined when the court code is not in COURT_TO_AUSTLII_PATH.
 */
function austliiUrlFromNeutral(neutralCitation: string): string | undefined {
  const m = normaliseCitation(neutralCitation).match(NEUTRAL_CITATION_PATTERN);
  if (!m) return undefined;
  const [, year, court, num] = m;
  const austliiPath = COURT_TO_AUSTLII_PATH[court!];
  if (!austliiPath) return undefined;
  return `https://www.austlii.edu.au/cgi-bin/viewdoc/${austliiPath}/${year}/${num}.html`;
}

/**
 * Build a filesystem-safe key for a cited-by source file.
 * e.g. parent "mabo1992" + "[2024] HCA 5" → "mabo1992_citing_2024_hca_5"
 */
function citedBySourceKey(parentCiteKey: string, neutralCitation: string): string {
  const slug = neutralCitation
    .replace(/[[\]]/g, "")
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
  return `${parentCiteKey}_citing_${slug}`;
}

/** Citing-case result shape used by the LawCite helper. */
interface LawCiteResult {
  caseName: string;
  url: string;
  neutralCitation?: string;
  court?: string;
}

/**
 * Fetch citing cases for a citation/title from AustLII's LawCite citator.
 * Returns the list of citing cases and a totalCount equal to the number of
 * results parsed from the LawCite response. No authentication is required.
 */
async function fetchCitingCasesFromLawCite(
  query: string,
): Promise<{ results: LawCiteResult[]; totalCount: number }> {
  const lawciteUrl = `${config.lawcite.baseUrl}?cit=${encodeURIComponent(query)}&nolinks=1`;
  const response = await withRetry(
    async () => {
      await lawciteRateLimiter.throttle();
      return axios.get(lawciteUrl, {
        headers: lawciteHeaders(),
        timeout: config.lawcite.timeout,
        responseType: "text",
      });
    },
    { label: "LawCite lookup (cited-by)" },
  );

  const $ = cheerio.load(response.data as string);
  const results: LawCiteResult[] = [];

  $("a[href*='austlii.edu.au']").each((_, el) => {
    const href = $(el).attr("href") || "";
    if (!href.includes("/cases/")) return;

    const title = $(el).text().trim();
    if (!title) return;

    const parentText = $(el).parent().text();
    const citationMatch = parentText.match(/\[(\d{4})\]\s+([A-Z]+(?:\s+[A-Z]+)?)\s+(\d+)/);
    const neutralCitation = citationMatch ? citationMatch[0] : undefined;
    const court = citationMatch ? citationMatch[2]?.trim() : undefined;

    const url = href.startsWith("http") ? href : `https://www.austlii.edu.au${href}`;

    if (results.some((r) => r.url === url)) return;

    results.push({
      caseName: title,
      url,
      neutralCitation,
      court,
    });
  });

  return { results, totalCount: results.length };
}

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
    citeKey: z
      .string()
      .optional()
      .describe(
        "Cite key of an existing cache entry to associate with this fetch (updates source fields).",
      ),
  };
  const fetchDocumentParser = z.object(fetchDocumentShape);

  server.registerTool(
    "auslaw_fetch_document_text",
    {
      title: "Fetch Document Text",
      description:
        "Fetch full text for a legislation or case URL (AustLII), with OCR fallback for scanned PDFs. When a `citeKey` is supplied and AUSLAW_FETCH_SOURCES is not set to 'false', also saves a local markdown copy to the sources directory and updates the cache entry's HTTP freshness headers. Without `citeKey`, only the document text is returned.",
      inputSchema: fetchDocumentShape,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (rawInput) => {
      const { url, format, citeKey } = fetchDocumentParser.parse(rawInput);
      const response = await fetchDocumentText(url);

      // Auto-store source when enabled and a citeKey is provided or fetchByDefault is on
      if (config.sources.fetchByDefault && citeKey) {
        try {
          const existing = await getCitation(config.cache.dir, citeKey);
          const storeResult = await storeSource(
            citeKey,
            url,
            existing,
            config.sources.dir,
            response,
          );
          const relPath = path.relative(config.cache.dir, storeResult.path);
          await updateSourceFields(config.cache.dir, citeKey, {
            sourceFile: relPath,
            contentHash: storeResult.contentHash,
            sourceFetchedAt: new Date().toISOString(),
            sourceEtag: storeResult.etag,
            sourceLastModified: storeResult.lastModified,
          });
        } catch {
          // Source storage is best-effort — don't fail the fetch
        }
      }

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
        const response = await withRetry(
          async () => {
            await lawciteRateLimiter.throttle();
            return axios.get(lawciteUrl, {
              headers: lawciteHeaders(),
              timeout: config.lawcite.timeout,
              responseType: "text",
            });
          },
          { label: "LawCite lookup" },
        );

        const $ = cheerio.load(response.data as string);
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

  // ── cache_citation ────────────────────────────────────────────────────────
  const cacheCitationShape = {
    title: z.string().min(1).describe("Case name, e.g. 'Mabo v Queensland (No 2)'"),
    neutralCitation: z.string().optional().describe("Neutral citation, e.g. '[1992] HCA 23'"),
    reportedCitation: z.string().optional().describe("Reported citation, e.g. '(1992) 175 CLR 1'"),
    url: z.string().url().describe("Primary source URL (AustLII)"),
    type: z
      .enum(["case", "legislation", "secondary", "treaty"])
      .default("case")
      .describe("Source type"),
    jurisdiction: z.string().optional(),
    year: z.number().int().optional().describe("Decision year"),
    court: z.string().optional().describe("Court code, e.g. 'HCA'"),
    keywords: z.array(z.string()).optional(),
    summary: z.string().optional().describe("Brief abstract of the source"),
    document: z
      .string()
      .optional()
      .describe("Logical document name this citation belongs to, e.g. 'essay-chapter-3'"),
    footnoteNumber: z
      .number()
      .int()
      .optional()
      .describe("Footnote number where this citation first appears in `document`"),
    pinpoint: z
      .string()
      .optional()
      .describe("Pinpoint to include in the AGLC4 full form, e.g. '[20]' or '401 to 407'"),
    style: z
      .enum(["neutral", "reported", "combined"])
      .default("combined")
      .describe("Which citation components to include in aglc4Full"),
  };
  const cacheCitationParser = z.object(cacheCitationShape);

  server.registerTool(
    "cache_citation",
    {
      title: "Cache Citation",
      description:
        "Store or update a citation in the local project cache. Assigns a biblatex-compatible cite key on first use. Returns the cite key and canonical AGLC4 string.",
      inputSchema: cacheCitationShape,
    },
    async (rawInput) => {
      const {
        title,
        neutralCitation,
        reportedCitation,
        url,
        type,
        jurisdiction,
        year,
        court,
        keywords,
        summary,
        document,
        footnoteNumber,
        pinpoint,
        style,
      } = cacheCitationParser.parse(rawInput);

      const aglc4Full = formatAGLC4({
        title,
        neutralCitation: style !== "reported" ? neutralCitation : undefined,
        reportedCitation: style !== "neutral" ? reportedCitation : undefined,
        pinpoint,
      });

      const citeKey = await upsertCitation(config.cache.dir, {
        title,
        neutralCitation,
        reportedCitation,
        aglc4Full,
        url,
        type,
        jurisdiction,
        year,
        court,
        keywords,
        summary,
        document,
        footnoteNumber,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ citeKey, aglc4Full, cached: true }, null, 2),
          },
        ],
      };
    },
  );

  // ── get_cached_citation ───────────────────────────────────────────────────
  const getCachedCitationShape = {
    query: z
      .string()
      .min(1)
      .describe(
        "Cite key (e.g. 'mabo1992'), AGLC4 citation string, neutral citation, or case title",
      ),
  };
  const getCachedCitationParser = z.object(getCachedCitationShape);

  server.registerTool(
    "get_cached_citation",
    {
      title: "Get Cached Citation",
      description:
        "Retrieve a citation from the local cache without any network calls. Looks up by cite key, AGLC4 full string, neutral citation, or case title.",
      inputSchema: getCachedCitationShape,
    },
    async (rawInput) => {
      const { query } = getCachedCitationParser.parse(rawInput);
      const entry = await getCitation(config.cache.dir, query);
      if (!entry) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ found: false, query }) }],
        };
      }
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ found: true, ...entry }, null, 2) },
        ],
      };
    },
  );

  // ── list_bibliography ─────────────────────────────────────────────────────
  const listBibliographyShape = {
    document: z
      .string()
      .optional()
      .describe("Filter to citations used in this document. Omit for all project citations."),
    format: formatEnum.optional(),
  };
  const listBibliographyParser = z.object(listBibliographyShape);

  server.registerTool(
    "list_bibliography",
    {
      title: "List Bibliography",
      description:
        "List all cached citations for this project, optionally filtered to a specific document.",
      inputSchema: listBibliographyShape,
    },
    async (rawInput) => {
      const { document, format } = listBibliographyParser.parse(rawInput);
      const entries = await listCitations(config.cache.dir, document);
      const fmt = format ?? "json";

      if (fmt === "json") {
        return {
          content: [{ type: "text" as const, text: JSON.stringify(entries, null, 2) }],
          structuredContent: { format: "json", data: entries },
        };
      }
      if (fmt === "markdown") {
        const lines = entries.map((e) => `- **${e.citeKey}** — ${e.aglc4Full}`);
        return { content: [{ type: "text" as const, text: lines.join("\n") || "(empty)" }] };
      }
      // text / html
      const lines = entries.map((e, i) => `${i + 1}. [${e.citeKey}] ${e.aglc4Full}`);
      return { content: [{ type: "text" as const, text: lines.join("\n") || "(empty)" }] };
    },
  );

  // ── export_bibliography ───────────────────────────────────────────────────
  const exportBibliographyShape = {
    document: z
      .string()
      .optional()
      .describe("Export only citations used in this document. Omit for all project citations."),
    outputPath: z
      .string()
      .optional()
      .describe(
        "Write the .bib file to this absolute path. Defaults to <cacheDir>/<projectName>.bib",
      ),
  };
  const exportBibliographyParser = z.object(exportBibliographyShape);

  server.registerTool(
    "export_bibliography",
    {
      title: "Export Bibliography (.bib)",
      description:
        "Export cached citations as a BibLaTeX .bib file. Returns the bib text and the path where it was written.",
      inputSchema: exportBibliographyShape,
    },
    async (rawInput) => {
      const { document, outputPath } = exportBibliographyParser.parse(rawInput);
      const bibText = await exportBib(config.cache.dir, document);

      if (!bibText) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ path: null, entries: 0, bib: "" }, null, 2),
            },
          ],
        };
      }

      const defaultPath = path.join(
        config.cache.dir,
        AUSLAW_CACHE_DIR_NAME,
        `${config.cache.projectName}.bib`,
      );
      const writePath = outputPath ?? defaultPath;

      const { promises: fs } = await import("node:fs");
      await fs.mkdir(path.dirname(writePath), { recursive: true });
      await fs.writeFile(writePath, bibText, "utf-8");

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                path: writePath,
                entries: (bibText.match(/^@/gm) ?? []).length,
                bib: bibText,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ── format_short_citation ─────────────────────────────────────────────────
  const formatShortCitationShape = {
    title: z
      .string()
      .min(1)
      .describe("The abbreviated case name chosen at first reference, e.g. 'Mabo'"),
    mode: z
      .enum(["short", "ibid", "subsequent"])
      .default("short")
      .describe(
        "short = plain short form; ibid = Ibid (back-to-back same source); subsequent = title (n X)",
      ),
    footnoteRef: z
      .number()
      .int()
      .optional()
      .describe("Footnote number of first citation — required for 'subsequent' mode"),
    pinpointPara: z.number().int().optional().describe("Paragraph pinpoint number, e.g. 20 → [20]"),
    pinpointPage: z.number().int().optional().describe("Page pinpoint number, e.g. 401"),
  };
  const formatShortCitationParser = z.object(formatShortCitationShape);

  server.registerTool(
    "format_short_citation",
    {
      title: "Format Short-Form Citation",
      description:
        "Format an AGLC4-compliant short-form, Ibid, or subsequent reference. Use 'ibid' when citing the same source as the immediately preceding footnote; 'subsequent' for later references (requires footnoteRef).",
      inputSchema: formatShortCitationShape,
    },
    async (rawInput) => {
      const { title, mode, footnoteRef, pinpointPara, pinpointPage } =
        formatShortCitationParser.parse(rawInput);

      const pinpoint =
        pinpointPara !== undefined
          ? { type: "para" as const, n: pinpointPara }
          : pinpointPage !== undefined
            ? { type: "page" as const, n: pinpointPage }
            : undefined;

      const result = formatShortForm({ title, mode, footnoteRef, pinpoint });
      return { content: [{ type: "text" as const, text: result }] };
    },
  );

  // ── check_source_freshness ────────────────────────────────────────────────
  const checkSourceFreshnessShape = {
    citeKey: z.string().min(1).describe("Cite key of a cached citation, e.g. 'mabo1992'"),
  };
  const checkSourceFreshnessParser = z.object(checkSourceFreshnessShape);

  server.registerTool(
    "check_source_freshness",
    {
      title: "Check Source Freshness",
      description:
        "Check whether the locally cached source file for a citation is still current. Issues a conditional HEAD request using the stored ETag/Last-Modified. If the remote source is newer, downloads and updates the local copy automatically.",
      inputSchema: checkSourceFreshnessShape,
    },
    async (rawInput) => {
      const { citeKey } = checkSourceFreshnessParser.parse(rawInput);
      const entry = await getCitation(config.cache.dir, citeKey);

      if (!entry) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: `No cached citation found for key: ${citeKey}` }),
            },
          ],
        };
      }

      if (!entry.sourceEtag && !entry.sourceLastModified && !entry.contentHash) {
        // No source ever fetched — download now
        try {
          const storeResult = await storeSource(citeKey, entry.url, null, config.sources.dir);
          const relPath = path.relative(config.cache.dir, storeResult.path);
          await updateSourceFields(config.cache.dir, citeKey, {
            sourceFile: relPath,
            contentHash: storeResult.contentHash,
            sourceFetchedAt: new Date().toISOString(),
            sourceEtag: storeResult.etag,
            sourceLastModified: storeResult.lastModified,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    fresh: false,
                    changed: true,
                    sourceFile: relPath,
                    note: "Source downloaded for the first time",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: `Failed to download source: ${err instanceof Error ? err.message : String(err)}`,
                }),
              },
            ],
          };
        }
      }

      const freshness = await checkSourceFreshness(
        entry.url,
        entry.sourceEtag,
        entry.sourceLastModified,
      );

      if (!freshness.fresh) {
        // Remote is newer — re-download
        try {
          const storeResult = await storeSource(
            citeKey,
            entry.url,
            { contentHash: entry.contentHash },
            config.sources.dir,
          );
          const relPath = path.relative(config.cache.dir, storeResult.path);
          await updateSourceFields(config.cache.dir, citeKey, {
            sourceFile: relPath,
            contentHash: storeResult.contentHash,
            sourceFetchedAt: new Date().toISOString(),
            sourceEtag: storeResult.etag,
            sourceLastModified: storeResult.lastModified,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { fresh: false, changed: storeResult.changed, sourceFile: relPath },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: `Failed to refresh source: ${err instanceof Error ? err.message : String(err)}`,
                }),
              },
            ],
          };
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                fresh: true,
                changed: false,
                sourceFile: entry.sourceFile,
                lastChecked: new Date().toISOString(),
                etag: freshness.etag ?? entry.sourceEtag,
                lastModified: freshness.lastModified ?? entry.sourceLastModified,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ── cache_cited_by ────────────────────────────────────────────────────────
  const cacheCitedByShape = {
    citeKey: z
      .string()
      .min(1)
      .describe("Cite key of the parent case whose citing cases should be fetched and cached"),
  };
  const cacheCitedByParser = z.object(cacheCitedByShape);

  server.registerTool(
    "cache_cited_by",
    {
      title: "Cache Cited-By Results",
      description:
        "Fetch citing cases for a cached citation from LawCite (AustLII's citator) and store them locally. " +
        "Metadata is saved for all results; source files are downloaded for the top N entries " +
        "(controlled by AUSLAW_CITED_BY_DOWNLOAD_LIMIT, default 5). " +
        "Can be disabled via AUSLAW_CACHE_CITED_BY=false.",
      inputSchema: cacheCitedByShape,
    },
    async (rawInput) => {
      const { citeKey } = cacheCitedByParser.parse(rawInput);

      if (!config.citedBy.enabled) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "Cited-by caching is disabled (AUSLAW_CACHE_CITED_BY=false)",
              }),
            },
          ],
        };
      }

      const parent = await getCitation(config.cache.dir, citeKey);
      if (!parent) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: `No cached citation found for key: ${citeKey}` }),
            },
          ],
        };
      }

      // Search LawCite for cases that cite this one
      const query = parent.neutralCitation ?? parent.title;
      const { results, totalCount } = await fetchCitingCasesFromLawCite(query);

      // Guard: if the citator returns nothing but we have prior data, treat
      // this as a likely transient failure (network/HTML-shape change) rather
      // than a genuine empty set — preserve existing cache instead of erasing.
      if (results.length === 0 && totalCount === 0 && (parent.citedBy?.length ?? 0) > 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error:
                  "LawCite returned no results but existing cited-by data is present. " +
                  "Existing cache preserved.",
                existingCount: parent.citedBy!.length,
              }),
            },
          ],
        };
      }

      // Snapshot prior source fields so conditional GET (ETag/Last-Modified)
      // works correctly when cache_cited_by is called a second time.
      const priorSources = new Map(
        (parent.citedBy ?? [])
          .filter((r) => r.neutralCitation)
          .map((r) => [r.neutralCitation!, r] as const),
      );

      // Build CitedByRef entries — prefer AustLII URL where derivable
      const refs: CitedByRef[] = results.map((r) => {
        const derivedUrl = r.neutralCitation ? austliiUrlFromNeutral(r.neutralCitation) : undefined;
        const year = r.neutralCitation
          ? parseInt(r.neutralCitation.match(/\[(\d{4})\]/)?.[1] ?? "", 10) || undefined
          : undefined;
        return {
          title: r.caseName,
          neutralCitation: r.neutralCitation || undefined,
          aglc4Full: r.neutralCitation
            ? formatAGLC4({ title: r.caseName, neutralCitation: r.neutralCitation })
            : r.caseName,
          url: derivedUrl ?? r.url,
          year,
          court: r.court,
        };
      });

      const now = new Date().toISOString();
      await updateCitedBy(config.cache.dir, citeKey, refs, totalCount, now);

      // Optionally download sources for the top-N refs
      let sourcesDownloaded = 0;
      if (config.citedBy.downloadSources) {
        const toDownload = refs.slice(0, config.citedBy.downloadLimit);
        for (const ref of toDownload) {
          if (!ref.url || !ref.neutralCitation) continue;
          try {
            const fileKey = citedBySourceKey(citeKey, ref.neutralCitation);
            const prior = priorSources.get(ref.neutralCitation) ?? null;
            const storeResult = await storeSource(fileKey, ref.url, prior, config.sources.dir);
            const relPath = path.relative(config.cache.dir, storeResult.path);
            await updateCitedBySource(config.cache.dir, citeKey, ref.neutralCitation, {
              sourceFile: relPath,
              sourceFetchedAt: now,
              contentHash: storeResult.contentHash,
              sourceEtag: storeResult.etag,
              sourceLastModified: storeResult.lastModified,
            });
            sourcesDownloaded++;
          } catch {
            // Best-effort — one failure should not abort the rest
          }
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                citeKey,
                totalCount,
                cached: refs.length,
                sourcesDownloaded,
                citedByFetchedAt: now,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ── get_cited_by ──────────────────────────────────────────────────────────
  const getCitedByShape = {
    citeKey: z
      .string()
      .min(1)
      .describe("Cite key of the case to retrieve cached cited-by data for"),
    format: z.enum(["json", "markdown"]).default("json").optional(),
  };
  const getCitedByParser = z.object(getCitedByShape);

  server.registerTool(
    "get_cited_by",
    {
      title: "Get Cached Cited-By Data",
      description:
        "Return the locally cached cited-by list for a citation. Zero network calls. " +
        "Use cache_cited_by first to populate the data.",
      inputSchema: getCitedByShape,
    },
    async (rawInput) => {
      const { citeKey, format } = getCitedByParser.parse(rawInput);
      const entry = await getCitation(config.cache.dir, citeKey);

      if (!entry) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ found: false, citeKey }),
            },
          ],
        };
      }

      if (!entry.citedBy || entry.citedBy.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                found: true,
                citeKey,
                citedByFetchedAt: entry.citedByFetchedAt ?? null,
                totalCount: entry.citedByTotalCount ?? 0,
                citedBy: [],
                note: "No cited-by data cached. Run cache_cited_by to populate.",
              }),
            },
          ],
        };
      }

      const fmt = format ?? "json";
      if (fmt === "markdown") {
        const header = `**${entry.citedBy.length} of ${entry.citedByTotalCount ?? "?"} citing cases** (fetched ${entry.citedByFetchedAt ?? "unknown"})`;
        const lines = entry.citedBy.map((r) => {
          const source = r.sourceFile ? ` — source: \`${r.sourceFile}\`` : "";
          return `- ${r.aglc4Full ?? r.title}${source}`;
        });
        return { content: [{ type: "text" as const, text: [header, "", ...lines].join("\n") }] };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                found: true,
                citeKey,
                citedByFetchedAt: entry.citedByFetchedAt,
                totalCount: entry.citedByTotalCount,
                citedBy: entry.citedBy,
              },
              null,
              2,
            ),
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

async function probeAustLii(): Promise<DependencyProbe> {
  const start = Date.now();
  try {
    await axios.head(config.austlii.baseUrl, {
      timeout: 5000,
      headers: { "User-Agent": config.austlii.userAgent },
    });
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
