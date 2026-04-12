import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { z } from "zod";
import axios from "axios";
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
    "search_legislation",
    {
      title: "Search Legislation",
      description:
        "Search Australian and New Zealand legislation. Jurisdiction codes — state/territory: cth, nsw, vic, qld, sa, wa, tas, nt, act, federal, nz, other (omit for all). Methods: auto, title (titles only), phrase (exact match), all (all words), any (any word), near (proximity), legis (legislation names). Use offset for pagination.",
      inputSchema: searchLegislationShape,
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
    fromYear: z.number().int().min(1900).max(2100).optional()
      .describe("Filter to cases decided on or after this year"),
    toYear: z.number().int().min(1900).max(2100).optional()
      .describe("Filter to cases decided on or before this year"),
  };
  const searchCasesParser = z.object(searchCasesShape);

  server.registerTool(
    "search_cases",
    {
      title: "Search Cases",
      description:
        "Search Australian and New Zealand case law. Jurisdiction codes — state/territory: cth, nsw, vic, qld, sa, wa, tas, nt, act, federal, nz, other; court-specific: hca, fca, fcafc, fcca, nswca, nswcca, nswsc, nswdc, nswlec, vicca, vsc, qca, qsc, sasc, wasc, tassc, ntsc, actsc (omit for all). Methods: auto, title (case names only), phrase (exact match), all (all words), any (any word), near (proximity), boolean. Sorting: auto (smart detection), relevance, date. Use offset for pagination (e.g., offset=50 for page 2).",
      inputSchema: searchCasesShape,
    },
    async (rawInput) => {
      const { query, jurisdiction, limit, format, sortBy, method, offset, fromYear, toYear } =
        searchCasesParser.parse(rawInput);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let results = await searchAustLii(query, { type: "case", jurisdiction: jurisdiction as any, limit, sortBy, method, offset });

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
    "fetch_document_text",
    {
      title: "Fetch Document Text",
      description:
        "Fetch full text for a legislation or case URL (AustLII), with OCR fallback for scanned PDFs.",
      inputSchema: fetchDocumentShape,
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
  };
  const formatCitationParser = z.object(formatCitationShape);

  server.registerTool(
    "format_citation",
    {
      title: "Format AGLC4 Citation",
      description:
        "Format an Australian case citation according to AGLC4 rules. Combines case name, neutral citation, reported citation, and optional pinpoint into the correct format.",
      inputSchema: formatCitationShape,
    },
    async (rawInput) => {
      const { title, neutralCitation, reportedCitation, pinpoint, style } =
        formatCitationParser.parse(rawInput);

      const info = {
        title,
        neutralCitation: style !== "reported" ? neutralCitation : undefined,
        reportedCitation: style !== "neutral" ? reportedCitation : undefined,
        pinpoint,
      };
      const formatted = formatAGLC4(info);
      return { content: [{ type: "text" as const, text: formatted }] };
    },
  );

  // ── validate_citation ─────────────────────────────────────────────────────
  const validateCitationShape = {
    citation: z.string().min(1).describe("Neutral citation to validate, e.g. '[1992] HCA 23'"),
  };
  const validateCitationParser = z.object(validateCitationShape);

  server.registerTool(
    "validate_citation",
    {
      title: "Validate Citation Against AustLII",
      description:
        "Validate a neutral citation by checking it exists on AustLII. Returns the canonical URL if valid.",
      inputSchema: validateCitationShape,
    },
    async (rawInput) => {
      const { citation } = validateCitationParser.parse(rawInput);
      const result = await validateCitation(citation);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
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
  };
  const generatePinpointParser = z
    .object(generatePinpointShape)
    .refine(
      (d) => d.paragraphNumber !== undefined || d.phrase !== undefined,
      "Provide at least one of paragraphNumber or phrase",
    );

  server.registerTool(
    "generate_pinpoint",
    {
      title: "Generate Pinpoint Citation",
      description:
        "Fetch a judgment from AustLII and generate a pinpoint citation to a specific paragraph (by number or by searching for a phrase).",
      inputSchema: generatePinpointShape,
    },
    async (rawInput) => {
      const { url, paragraphNumber, phrase, caseCitation } = generatePinpointParser.parse(rawInput);
      const doc = await fetchDocumentText(url);
      if (!doc.paragraphs || doc.paragraphs.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "No paragraph blocks found in document" }),
            },
          ],
        };
      }
      const pinpoint = generatePinpoint(doc.paragraphs, { paragraphNumber, phrase });
      if (!pinpoint) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "Paragraph not found" }),
            },
          ],
        };
      }
      const fullCitation = caseCitation
        ? `${caseCitation} ${pinpoint.pinpointString}`
        : pinpoint.pinpointString;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ...pinpoint, fullCitation }, null, 2),
          },
        ],
      };
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
    "search_by_citation",
    {
      title: "Search by Citation",
      description:
        "Find a case by its citation. If a neutral citation is detected, validates it against AustLII and returns the direct URL. Otherwise performs a case name search.",
      inputSchema: searchByCitationShape,
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
      .describe("Neutral citation or case name to find citing cases for, e.g. '[1992] HCA 23' or 'Mabo v Queensland (No 2)'"),
    format: formatEnum.optional(),
  };
  const searchCitingCasesParser = z.object(searchCitingCasesShape);

  server.registerTool(
    "search_citing_cases",
    {
      title: "Search Citing Cases (Citator)",
      description:
        "Find cases that cite a given case. Uses LawCite (AustLII's citator service) to find citing cases. Returns citing cases with case names, AustLII URLs, neutral citations, and court/date information where available.",
      inputSchema: searchCitingCasesShape,
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
        await lawciteRateLimiter.throttle();
        const lawciteUrl = `${config.lawcite.baseUrl}?cit=${encodeURIComponent(cit)}&nolinks=1`;
        const response = await axios.get(lawciteUrl, {
          headers: {
            "User-Agent": config.austlii.userAgent,
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            Referer: "https://www.austlii.edu.au/",
          },
          timeout: config.lawcite.timeout,
          responseType: "text",
        });

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
        console.warn(
          "LawCite lookup failed, falling back to AustLII phrase search:",
          err instanceof Error ? err.message : String(err),
        );
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
    "fetch_legislation_section",
    {
      title: "Fetch Legislation Section",
      description:
        "Fetch the text of a specific section or schedule from an Australian Act on AustLII. " +
        "More efficient than fetch_document_text on the whole Act when you only need one provision. " +
        "Accepts the Act's AustLII URL and a section reference like '18', 's 18', 'section 18', 'schedule 1'.",
      inputSchema: {
        url: z.string().url().describe("AustLII URL of the Act, e.g. 'https://www.austlii.edu.au/au/legis/cth/consol_act/cca2010265/'"),
        section: z.string().min(1).describe("Section reference, e.g. '18', 's 18', 'section 18A', 'schedule 1', 'sch 2'"),
      },
    },
    async (rawInput) => {
      const { url, section } = z.object({
        url: z.string().url(),
        section: z.string().min(1),
      }).parse(rawInput);

      // Normalise section reference to AustLII path segment
      const norm = section.trim().toLowerCase()
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
          content: [{ type: "text" as const, text: JSON.stringify({
            error: "invalid_section",
            message: `Could not parse section reference "${section}". Use formats like "18", "s 18", "18A", "schedule 1".`,
          }) }],
          isError: true,
        };
      }

      const baseUrl = url.replace(/\/+$/, "");
      const sectionUrl = `${baseUrl}/${norm}.html`;

      try {
        assertFetchableUrl(sectionUrl);
      } catch {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            error: "invalid_url",
            message: "Only AustLII URLs are supported.",
          }) }],
          isError: true,
        };
      }

      let doc;
      try {
        doc = await fetchDocumentText(sectionUrl);
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            error: "fetch_failed",
            message: `Could not retrieve section ${section}. The section may not exist at this URL, or AustLII may be temporarily unavailable.`,
            detail: err instanceof Error ? err.message : String(err),
          }) }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          act_url: url,
          section_url: sectionUrl,
          section_ref: section,
          text: doc.text,
        }) }],
      };
    }
  );

  return server;
}

async function main() {
  if (process.env.MCP_TRANSPORT === "http") {
    const port = parseInt(process.env.PORT ?? "3000", 10);
    createServer(async (req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
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
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const bodyStr = Buffer.concat(chunks).toString();
        const body = bodyStr ? (JSON.parse(bodyStr) as Record<string, unknown>) : undefined;
        await transport.handleRequest(req, res, body);
      } catch (err) {
        console.error("auslaw-mcp request error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : "Internal server error",
            }),
          );
        }
      }
    }).listen(port, () => {
      console.error(`auslaw-mcp HTTP transport listening on :${port}`);
    });
  } else {
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

main().catch((error) => {
  console.error("Fatal server error", error);
  process.exit(1);
});
