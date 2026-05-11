/**
 * Configuration module for AusLaw MCP
 * Loads and validates configuration from environment variables.
 * Fails fast at startup if any required variable is missing or invalid.
 */

import path from "node:path";
import { z } from "zod";

// ── Zod schema ────────────────────────────────────────────────────────────────
// Coerces numeric strings, applies defaults, and validates ranges.
// Any misconfigured env var (e.g. AUSTLII_TIMEOUT=abc) throws at startup
// rather than silently producing NaN at request time.

const numericEnv = (defaultVal: string) =>
  z.string().default(defaultVal).pipe(z.coerce.number().int().positive());

const EnvSchema = z.object({
  AUSTLII_BASE_URL: z.string().url().default("https://www.austlii.edu.au"),
  AUSTLII_SEARCH_BASE: z.string().url().default("https://www.austlii.edu.au/cgi-bin/sinosrch.cgi"),
  AUSTLII_REFERER: z.string().url().default("https://www.austlii.edu.au/forms/search1.html"),
  AUSTLII_USER_AGENT: z
    .string()
    .default(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    ),
  AUSTLII_TIMEOUT: numericEnv("60000"),
  LAWCITE_BASE_URL: z.string().url().default("https://www.austlii.edu.au/cgi-bin/LawCite"),
  LAWCITE_TIMEOUT: numericEnv("15000"),
  OCR_LANGUAGE: z.string().default("eng"),
  OCR_OEM: numericEnv("1"),
  OCR_PSM: numericEnv("3"),
  DEFAULT_SEARCH_LIMIT: numericEnv("10"),
  MAX_SEARCH_LIMIT: numericEnv("50"),
  DEFAULT_OUTPUT_FORMAT: z.string().default("json"),
  DEFAULT_SORT_BY: z.string().default("auto"),
  LOG_LEVEL: z.string().default("1"),
  PORT: numericEnv("3000"),
  MCP_TRANSPORT: z.enum(["stdio", "http"]).default("stdio"),
});

// ── Config shape (unchanged public API) ──────────────────────────────────────

export interface Config {
  austlii: {
    baseUrl: string;
    searchBase: string;
    referer: string;
    userAgent: string;
    timeout: number;
  };
  lawcite: {
    baseUrl: string;
    timeout: number;
  };
  ocr: {
    language: string;
    oem: number;
    psm: number;
  };
  defaults: {
    searchLimit: number;
    maxSearchLimit: number;
    outputFormat: string;
    sortBy: string;
  };
  cache: {
    /** Base directory for the .auslaw/ cache folder. Defaults to cwd. */
    dir: string;
    /** Project name used in bib exports and multi-doc tracking. Defaults to basename of dir. */
    projectName: string;
  };
  sources: {
    /** Directory where source markdown files are saved. */
    dir: string;
    /** When true, fetch_document_text automatically saves a local source copy. */
    fetchByDefault: boolean;
  };
  citedBy: {
    /** Cache cited-by results from LawCite citator lookups. */
    enabled: boolean;
    /** Download source files for the top-N citing cases when caching cited-by results. */
    downloadSources: boolean;
    /** Maximum number of citing-case sources to download per lookup. */
    downloadLimit: number;
  };
}

/**
 * Load and validate configuration from environment variables.
 * Throws at startup with a descriptive error if any value is invalid.
 *
 * @returns A fully-populated {@link Config} object
 */
export function loadConfig(): Config {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`auslaw-mcp configuration error:\n${issues}`);
  }
  const env = result.data;

  const cacheDir = process.env.AUSLAW_CACHE_DIR ?? process.cwd();
  const projectName = process.env.AUSLAW_PROJECT_NAME ?? path.basename(cacheDir);
  const sourcesDir = process.env.AUSLAW_SOURCES_DIR ?? path.join(cacheDir, "sources");

  return {
    austlii: {
      baseUrl: env.AUSTLII_BASE_URL,
      searchBase: env.AUSTLII_SEARCH_BASE,
      referer: env.AUSTLII_REFERER,
      userAgent: env.AUSTLII_USER_AGENT,
      timeout: env.AUSTLII_TIMEOUT,
    },
    lawcite: {
      baseUrl: env.LAWCITE_BASE_URL,
      timeout: env.LAWCITE_TIMEOUT,
    },
    ocr: {
      language: env.OCR_LANGUAGE,
      oem: env.OCR_OEM,
      psm: env.OCR_PSM,
    },
    defaults: {
      searchLimit: env.DEFAULT_SEARCH_LIMIT,
      maxSearchLimit: env.MAX_SEARCH_LIMIT,
      outputFormat: env.DEFAULT_OUTPUT_FORMAT,
      sortBy: env.DEFAULT_SORT_BY,
    },
    cache: {
      dir: cacheDir,
      projectName,
    },
    sources: {
      dir: sourcesDir,
      fetchByDefault: process.env.AUSLAW_FETCH_SOURCES !== "false",
    },
    citedBy: {
      enabled: process.env.AUSLAW_CACHE_CITED_BY !== "false",
      downloadSources: process.env.AUSLAW_DOWNLOAD_CITED_BY_SOURCES !== "false",
      downloadLimit: parseInt(process.env.AUSLAW_CITED_BY_DOWNLOAD_LIMIT ?? "5", 10) || 5,
    },
  };
}

// Export a singleton instance — throws at module load time if env is invalid
export const config = loadConfig();
