# auslaw-mcp - Claude Code Project Instructions

## Project Overview

MCP server for Australian/NZ legal research. Searches AustLII, retrieves full-text judgments, formats AGLC4 citations, and looks up citing cases via LawCite.

> **Note:** jade.io integration was removed. All search, document fetch, and citation lookup now uses public AustLII services only (no authentication required).

## Build & Test

```bash
npm run build          # TypeScript compile
npm test               # All tests (unit + integration + perf; integration hits live services)
npx vitest run src/test/unit/  # Unit tests only (fast, no network)
npm run lint           # ESLint (flat config via eslint.config.mjs)
npm run lint:fix       # Auto-fix lint issues
```

- Always run `npm run build` before pushing (CI runs on push)
- Unit tests must all pass before committing; integration/perf test failures from network timeouts are acceptable
- ESLint uses flat config (`eslint.config.mjs`), NOT legacy `.eslintrc`

## Key Architecture

- `src/index.ts` - MCP server, 9 tool registrations
- `src/services/austlii.ts` - AustLII search with authority-based ranking
- `src/services/citation.ts` - AGLC4 formatting, validation, pinpoints
- `src/services/fetcher.ts` - Document retrieval (HTML, PDF, OCR) from AustLII URLs only
- `src/utils/url-guard.ts` - SSRF protection (austlii.edu.au only)
- `src/utils/rate-limiter.ts` - Token bucket rate limiters (austlii: 10 req/min, lawcite: 5 req/min)

## Tools

| Tool | Description |
|---|---|
| `search_cases` | AustLII case search with authority-based ranking |
| `search_legislation` | AustLII legislation search |
| `fetch_document_text` | Fetch full text from AustLII URL (HTML/PDF/OCR) |
| `search_citing_cases` | LawCite citator — find cases that cite a given citation |
| `search_by_citation` | Resolve neutral citation to AustLII URL |
| `validate_citation` | Validate and resolve a neutral citation via AustLII HEAD request |
| `format_citation` | AGLC4 citation formatting |
| `generate_pinpoint` | Generate paragraph-level pinpoint reference |
| `fetch_legislation_section` | Fetch a specific section or schedule from an Act on AustLII |

## Environment Variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `PORT` | No | 3000 | HTTP port |
| `MCP_TRANSPORT` | No | stdio | `stdio` or `http` |
| `AUSTLII_BASE_URL` | No | https://www.austlii.edu.au | Override for testing |
| `LAWCITE_BASE_URL` | No | https://www.austlii.edu.au/cgi-bin/LawCite | LawCite endpoint |
| `LAWCITE_TIMEOUT` | No | 15000 | LawCite request timeout (ms) |
| `LOG_LEVEL` | No | 1 (INFO) | 0=DEBUG, 1=INFO, 2=WARN, 3=ERROR |

## LawCite Integration

`search_citing_cases` fetches `https://www.austlii.edu.au/cgi-bin/LawCite?cit={citation}&nolinks=1`, parses the HTML with cheerio to extract citing case links, then falls back to AustLII phrase search if LawCite returns no results.

No authentication required. Rate limited to 5 req/min.

## Testing Notes

- Fixtures in `src/test/fixtures/` - static responses for deterministic unit tests
- Integration tests in `src/test/scenarios.test.ts` hit live AustLII; flaky due to network
- Performance tests in `src/test/performance/` have generous timeouts but still flake under load
