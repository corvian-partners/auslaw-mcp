# auslaw-mcp Roadmap

## Current State

| Tool | Source | Status |
|------|--------|--------|
| `search_cases` | AustLII | Working |
| `search_legislation` | AustLII | Working |
| `fetch_document_text` | AustLII (HTML, PDF) | Working |
| `resolve_jade_article` | jade.io (title metadata) | Working |
| `jade_citation_lookup` | jade.io (URL construction) | Working |
| `fetch_document_text` | jade.io | Not supported (see below) |

---

## jade.io Full-Text Fetching

### Why it doesn't work today

jade.io (BarNet Jade) is a GWT (Google Web Toolkit) single-page application. The initial HTTP
response for any `https://jade.io/article/<id>` URL is a ~12KB JavaScript bootstrap shell. The
actual judgment text is loaded client-side by the GWT runtime via subsequent XHR requests. A
simple HTTP fetch + HTML extraction pipeline (the current approach for AustLII) returns empty
content for jade.io URLs. As of this writing, `fetch_document_text` throws an explicit error for
jade.io URLs rather than silently returning empty content.

### Why jade.io matters

- AustLII carries most published Australian judgments, but jade.io provides:
  - Reported citations (e.g. `(2024) 98 ALJR 123`) alongside neutral citations
  - Earlier and more complete coverage of some state courts
  - Annotations, catchwords, and judgment summaries not on AustLII
  - Better family law coverage including some FCFCA unreported decisions

---

## Planned Investigation: jade.io API Reverse Engineering

Before committing to a heavy headless-browser dependency, investigate whether jade.io's
backend XHR API can be called directly with session credentials.

### Phase 1 — Network Traffic Analysis

**Goal:** Identify the XHR endpoints the GWT app uses to load judgment text.

Tasks:
- [ ] Open Chrome DevTools Network tab on an authenticated jade.io session
- [ ] Navigate to a known judgment (e.g. `jade.io/article/67401`)
- [ ] Filter for XHR/Fetch requests and capture all calls after initial page load
- [ ] Identify endpoints that return judgment content (likely JSON or XML)
- [ ] Document: URL patterns, request headers, authentication mechanism, response schema
- [ ] Check whether `alcsessionid` / `IID` cookies alone are sufficient or if additional
      tokens (CSRF, GWT permutation token) are required

Key things to look for:
- Does jade.io use a REST API or GWT-RPC (binary protocol)?
- Are response payloads JSON, XML, or GWT serialisation format?
- Is there pagination or streaming for long judgments?
- Are there rate limits or bot-detection headers?

### Phase 2 — Feasibility Assessment

Based on Phase 1 findings, assess which path to take:

#### Option A: Direct API calls (preferred if feasible)

If jade.io's backend API is accessible with standard HTTP + session cookies:

- Implement a `fetchJadeArticle(articleId)` function in `src/services/jade.ts`
- Parse the API response format (JSON/XML/GWT-RPC)
- Integrate with the existing `fetch_document_text` tool (remove the "not supported" error)
- Session cookie extraction via `browser_cookie3` can be scripted:
  ```bash
  python3 -c "
  import browser_cookie3
  auth = ['IID','alcsessionid','cf_clearance']
  cookies = browser_cookie3.chrome(domain_name='jade.io')
  print('; '.join(f'{c.name}={c.value}' for c in cookies if c.name in auth))
  "
  ```

Pros: No new binary dependencies, fast, works headlessly in any environment.
Cons: Fragile to API changes; potentially against jade.io ToS.

#### Option B: Headless browser via Playwright (fallback)

If the API is GWT-RPC (binary) or requires JavaScript execution to authenticate:

- Add `@playwright/test` or `playwright-core` as an optional dependency
- Implement a `JadeBrowser` singleton that keeps a Chromium instance alive for the
  lifetime of the MCP server process (MCP servers are long-running, so startup cost
  is amortised)
- Navigate to `jade.io/article/<id>`, wait for the GWT content selector to appear,
  extract inner text/HTML
- Pass the user's existing Chrome session profile path to avoid re-authentication

Pros: Handles any page, most reliable, works regardless of API complexity.
Cons: ~300MB Chromium binary, adds process management complexity, potential
      memory pressure in constrained environments.

#### Option C: Claude-in-Chrome MCP bridge (experimental)

Leverage the existing `mcp__claude-in-chrome__*` tools to navigate jade.io in the
user's running Chrome instance (already authenticated):

- New MCP tool `fetch_jade_document(url)` internally calls the Chrome MCP
- Navigate to the jade.io URL, wait for GWT render, extract text
- No Playwright dependency; reuses existing Chrome session

Pros: Zero extra dependencies, uses existing authenticated session.
Cons: Only works when Claude Code is running with the Chrome MCP active and a
      Chrome window is open; not suitable for CI/headless contexts; tight coupling
      between two MCPs.

### Phase 3 — Implementation

Based on Phase 2 assessment, implement the chosen option:

- [ ] Implement `fetchJadeDocument()` in `src/services/jade.ts`
- [ ] Update `fetchDocumentText` in `src/services/fetcher.ts` to route jade.io URLs
      through the new implementation (remove early-rejection error)
- [ ] Add integration tests against live jade.io (tagged `@live`, skipped in CI)
- [ ] Update `.env.example` with cookie extraction instructions
- [ ] Document the cookie refresh workflow (cookies expire; `browser_cookie3` script
      should be the canonical refresh mechanism)

---

## Other Planned Improvements

### PDF output format for `fetch_document_text`

Currently requires a two-step workflow (fetch HTML, convert with Chrome headless externally).
A `format: "pdf"` option could shell out to `chromium --headless --print-to-pdf` and return
a base64-encoded PDF or write to a temp path.

### Configurable content selectors

AustLII and jade.io page structure changes occasionally break cheerio selectors. A config
file mapping host patterns to CSS selectors would make this maintainable without code changes.

### Citation format support

Expand `generatePinpoint` to support reported citations (CLR, ALJR, FCR, etc.) in addition
to neutral citations.
