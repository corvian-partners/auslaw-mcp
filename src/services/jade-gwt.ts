/**
 * jade.io GWT-RPC utilities
 *
 * jade.io uses GWT-RPC (Google Web Toolkit Remote Procedure Call) as its
 * wire protocol. This module provides:
 *
 * - GWT integer encoding (custom base-64 used in serialised object IDs)
 * - Request body builders for the two article-content methods
 * - Response parser that extracts the string payload from //OK[...] envelopes
 *
 * Findings captured from Proxyman HAR: jade.io_03-02-2026-13-48-33.har
 * Article tested: 67401 (Kosciusko Thredbo Pty Ltd v Commissioner of Taxation [1987] HCA 64)
 */

/**
 * GWT's custom base-64 charset.
 * Index 0 = 'A', 25 = 'Z', 26 = 'a', 51 = 'z', 52 = '0', 61 = '9', 62 = '$', 63 = '_'
 */
const GWT_CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789$_";

/** jade.io GWT module base URL — part of the serialisation header */
export const JADE_MODULE_BASE = "https://jade.io/au.com.barnet.jade.JadeClient/";

/**
 * GWT-RPC strong name (type hash) for JadeRemoteService.
 * This may change when jade.io redeploys the GWT app.
 * If content fetching returns an exception response, this hash may need refreshing
 * by inspecting the X-GWT-Permutation header in a fresh browser session.
 */
export const JADE_STRONG_NAME = "16E3F568878E6841670449E07D95BA3E";

/**
 * GWT-RPC strong name (type hash) for ArticleViewRemoteService.
 * This service handles article content loading via the avd2Request method.
 * Discovered via SPA navigation interception (2026-03-02).
 */
export const AVD2_STRONG_NAME = "E2F710F48F8237D9E1397729B9933A69";

/**
 * GWT permutation identifier for the Chrome/macOS compiled JS bundle.
 * Sent in the X-GWT-Permutation request header.
 * Different from JADE_STRONG_NAME — this identifies the browser-specific
 * JavaScript permutation, not the serialisation type hash.
 */
export const JADE_PERMUTATION = "0BCBB10F3C94380A7BB607710B95A8EF";

/**
 * Encodes a non-negative integer using GWT's custom base-64 charset.
 *
 * GWT represents integers in its RPC wire format using a compact base-64
 * encoding with the charset A-Z (0-25), a-z (26-51), 0-9 (52-61), $ (62), _ (63).
 *
 * Example: 67401 = 16*64² + 29*64 + 9 → 'Q' + 'd' + 'J' = "QdJ"
 *
 * @param n - Non-negative integer to encode
 * @returns GWT base-64 encoded string
 * @throws Error if n is negative or non-integer
 */
export function encodeGwtInt(n: number): string {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`GWT int encoding: non-negative integer required, got: ${n}`);
  }
  if (n === 0) return "A";

  let result = "";
  let remaining = n;
  while (remaining > 0) {
    result = GWT_CHARSET[remaining & 63]! + result;
    remaining = Math.floor(remaining / 64);
  }
  return result;
}

/**
 * Builds the GWT-RPC POST body for JadeRemoteService.getInitialContent(articleId).
 *
 * The request body template was captured verbatim from a live authenticated
 * session (Proxyman HAR, 2026-03-02). Only the GWT-encoded article ID changes
 * between requests; the string table and token stream are otherwise fixed.
 *
 * @param articleId - Numeric jade.io article ID
 * @returns GWT-RPC v7 serialised request body string
 */
export function buildGetInitialContentRequest(articleId: number): string {
  const encodedId = encodeGwtInt(articleId);
  return (
    `7|0|7|${JADE_MODULE_BASE}|${JADE_STRONG_NAME}|` +
    `au.com.barnet.jade.cs.remote.JadeRemoteService|` +
    `getInitialContent|` +
    `au.com.barnet.jade.cs.persistent.Jrl/728826604|` +
    `au.com.barnet.jade.cs.persistent.Article|` +
    `java.util.ArrayList/4159755760|` +
    `1|2|3|4|1|5|5|${encodedId}|A|0|A|A|6|0|`
  );
}

/**
 * Builds the GWT-RPC POST body for JadeRemoteService.getArticleStructuredMetadata(articleId).
 *
 * Returns a schema.org JSON string with the case name and neutral citation.
 * This call takes an int (JNI type 'J') rather than a Jrl object, making
 * it simpler than getInitialContent.
 *
 * @param articleId - Numeric jade.io article ID
 * @returns GWT-RPC v7 serialised request body string
 */
export function buildGetMetadataRequest(articleId: number): string {
  const encodedId = encodeGwtInt(articleId);
  return (
    `7|0|5|${JADE_MODULE_BASE}|${JADE_STRONG_NAME}|` +
    `au.com.barnet.jade.cs.remote.JadeRemoteService|` +
    `getArticleStructuredMetadata|J|` +
    `1|2|3|4|1|5|${encodedId}|`
  );
}

/**
 * Builds the GWT-RPC POST body for ArticleViewRemoteService.avd2Request(articleId).
 *
 * This is the primary method for loading article content on jade.io. Unlike
 * getInitialContent (which returns empty body when called directly), avd2Request
 * reliably returns the full article HTML including paragraph anchors.
 *
 * Discovered by intercepting SPA navigation within an authenticated jade.io
 * session (2026-03-02). The request template was captured from Jade Browser
 * case listing navigation to article 1182103.
 *
 * @param articleId - Numeric jade.io article ID
 * @returns GWT-RPC v7 serialised request body string
 */
export function buildAvd2Request(articleId: number): string {
  const encodedId = encodeGwtInt(articleId);
  return (
    `7|0|10|${JADE_MODULE_BASE}|${AVD2_STRONG_NAME}|` +
    `au.com.barnet.jade.cs.remote.ArticleViewRemoteService|avd2Request|` +
    `au.com.barnet.jade.cs.csobjects.avd.Avd2Request/2068227305|` +
    `au.com.barnet.jade.cs.persistent.Jrl/728826604|` +
    `au.com.barnet.jade.cs.persistent.Article|` +
    `java.util.ArrayList/4159755760|` +
    `au.com.barnet.jade.cs.csobjects.avd.PhraseFrequencyParams/1915696367|` +
    `cc.alcina.framework.common.client.util.IntPair/1982199244|` +
    `1|2|3|4|1|5|5|A|A|0|6|${encodedId}|A|0|A|A|7|0|0|0|8|0|0|9|0|10|3|500|A|8|0|`
  );
}

/**
 * Parses an avd2Request GWT-RPC response and extracts the article HTML.
 *
 * The avd2Request response is a complex GWT-RPC serialised object. The format
 * after stripping the //OK prefix is a JavaScript array (not strict JSON - it
 * uses "+" string concatenation for long strings):
 *
 *   [integer_refs..., [string_table_entries...], 4, 7]
 *
 * The HTML content is the longest string in the string table. Unicode escape
 * sequences (\u003C etc.) are decoded by JSON.parse automatically.
 *
 * @param responseText - Raw GWT-RPC response string from avd2Request
 * @returns Decoded HTML content string
 * @throws Error if the response is an exception, malformed, or contains no HTML
 */
export function parseAvd2Response(responseText: string): string {
  if (responseText.startsWith("//EX")) {
    throw new Error("jade.io GWT-RPC server returned an exception response");
  }
  if (!responseText.startsWith("//OK")) {
    throw new Error(
      `Unexpected GWT-RPC response format (expected //OK prefix): ${responseText.substring(0, 50)}`,
    );
  }

  // Strip //OK prefix and join GWT's string concatenation markers
  const stripped = responseText.slice(4);
  const joined = stripped.replace(/"\+"/g, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(joined);
  } catch (e) {
    throw new Error(`Failed to parse avd2 GWT-RPC response: ${e}`);
  }

  if (!Array.isArray(parsed) || parsed.length < 3) {
    throw new Error("avd2 GWT-RPC response has unexpected structure");
  }

  // Response format: [...integers..., [string_table], 4, 7]
  // The string table is a nested array at parsed[len-3]
  const stringTable = parsed[parsed.length - 3];
  if (!Array.isArray(stringTable) || stringTable.length === 0) {
    throw new Error("avd2 response: could not locate string table");
  }

  // The HTML content is the longest string in the string table
  let html = "";
  for (const entry of stringTable) {
    if (typeof entry === "string" && entry.length > html.length) {
      html = entry;
    }
  }

  if (!html || !html.includes("<")) {
    throw new Error("No HTML content found in avd2 GWT-RPC response string table");
  }

  return html;
}

/**
 * Parses a GWT-RPC response envelope and extracts the string payload.
 *
 * jade.io responses for both getInitialContent and getArticleStructuredMetadata
 * follow this structure:
 *   //OK[<type_token>, [], ["<payload_string>"], <flags>, <version>]
 *
 * The payload string (parsed[2][0]) is JSON-encoded; Unicode escape sequences
 * (\uXXXX) are decoded automatically by JSON.parse.
 *
 * @param responseText - Raw GWT-RPC response string
 * @returns Decoded payload string (HTML or JSON depending on the method called)
 * @throws Error if the response is a GWT exception (//EX), malformed, or has no content
 */
export function parseGwtRpcResponse(responseText: string): string {
  if (responseText.startsWith("//EX")) {
    throw new Error("jade.io GWT-RPC server returned an exception response");
  }
  if (!responseText.startsWith("//OK")) {
    throw new Error(
      `Unexpected GWT-RPC response format (expected //OK prefix): ${responseText.substring(0, 50)}`,
    );
  }

  const jsonPart = responseText.substring(4);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonPart);
  } catch (e) {
    throw new Error(`Failed to parse GWT-RPC response body as JSON: ${e}`);
  }

  if (!Array.isArray(parsed) || parsed.length < 3) {
    throw new Error(`GWT-RPC response has unexpected structure (need array of length >= 3)`);
  }

  const stringTable = parsed[2];
  if (!Array.isArray(stringTable) || stringTable.length === 0) {
    throw new Error(
      `GWT-RPC response has empty string table - article may not have content or may require authentication`,
    );
  }

  const content = stringTable[0];
  if (typeof content !== "string") {
    throw new Error(`GWT-RPC string table first element is not a string: ${typeof content}`);
  }

  return content;
}
