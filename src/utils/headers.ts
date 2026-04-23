/**
 * Centralised HTTP headers for AustLII and LawCite requests.
 *
 * AustLII gates out stale/bot-like User-Agents with HTTP 410 and varies on
 * `User-Agent`. Every outbound request must present the same modern-Chrome
 * navigation fingerprint — keep these in one place to avoid drift.
 */

import { config } from "../config.js";

const ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7";

const LAWCITE_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

const CLIENT_HINTS = {
  "sec-ch-ua": '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
} as const;

const NAV_FETCH_HEADERS = {
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-User": "?1",
} as const;

/** Full browser-navigation headers for top-level AustLII document fetches. */
export function austliiNavigationHeaders(): Record<string, string> {
  return {
    "User-Agent": config.austlii.userAgent,
    Accept: ACCEPT,
    "Accept-Language": "en-AU,en-GB;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Upgrade-Insecure-Requests": "1",
    ...NAV_FETCH_HEADERS,
    ...CLIENT_HINTS,
  };
}

/** Headers for AustLII search (includes Referer matching the search form). */
export function austliiSearchHeaders(): Record<string, string> {
  return {
    ...austliiNavigationHeaders(),
    Referer: config.austlii.referer,
  };
}

/** Minimal headers for LawCite — accepts HTML, carries a plausible Referer. */
export function lawciteHeaders(): Record<string, string> {
  return {
    "User-Agent": config.austlii.userAgent,
    Accept: LAWCITE_ACCEPT,
    Referer: "https://www.austlii.edu.au/",
  };
}

/** HEAD-request headers for citation validation. */
export function austliiHeadHeaders(): Record<string, string> {
  return {
    "User-Agent": config.austlii.userAgent,
    ...NAV_FETCH_HEADERS,
  };
}
