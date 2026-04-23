# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed (BREAKING)

- All MCP tools renamed with `auslaw_` prefix for namespace clarity:
  `search_cases` → `auslaw_search_cases`, `search_legislation` → `auslaw_search_legislation`,
  `fetch_document_text` → `auslaw_fetch_document_text`, `search_citing_cases` → `auslaw_search_citing_cases`,
  `search_by_citation` → `auslaw_search_by_citation`, `validate_citation` → `auslaw_validate_citation`,
  `format_citation` → `auslaw_format_citation`, `generate_pinpoint` → `auslaw_generate_pinpoint`,
  `fetch_legislation_section` → `auslaw_fetch_legislation_section`.
- Search JSON responses now wrap results as `{ totalResults, results }` instead of a bare array.

### Added

- Tool annotations (`readOnlyHint`, `idempotentHint`, `openWorldHint`) on every tool.
- Exponential-backoff retry with jitter for transient AustLII / LawCite failures (5xx, 429, 408, network).
- Expanded `/health?deep=1` endpoint probes AustLII reachability and Tesseract availability.
- `format_citation`, `validate_citation`, `generate_pinpoint` now honour the `format` parameter (json / text / markdown).
- Centralised HTTP header builders in `src/utils/headers.ts` (AustLII nav, search, HEAD, LawCite).

### Fixed

- Rate-limiter race condition where concurrent `throttle()` calls on the same tick could both enter `drain()` (FIFO was not guaranteed under high concurrency).
- Paragraph extraction dedup no longer silently drops legitimate duplicate paragraph numbers with distinct text.
- `pdf-parse` null-guard: `textResult?.text` before `.trim()` to avoid crash on empty PDFs.
- Unsafe non-null assertion on court code in `validateCitation`.
- CI/engine mismatch: CI was testing Node 20 & 22 while `package.json` required `>=22`. Now tests Node 22 & 24.

### Security

- `npm audit fix` applied — patched `follow-redirects` (GHSA-r4q5-vmmm-2653) and `hono` (GHSA-458j-xx4x-4375). 0 vulnerabilities remaining.

### Removed

- Stale jade.io references from `SECURITY.md` and `fetcher.ts`. SSRF allowlist already blocks non-AustLII hosts, making the explicit jade.io check redundant.

### Added (previous entries)

- jade.io search integration via AustLII cross-referencing (no API access required)
  - `search_jade` MCP tool for searching jade.io cases/legislation
  - `search_jade_by_citation` MCP tool for finding jade.io articles by neutral citation
  - `searchJade()` function: searches by cross-referencing AustLII results with jade.io metadata
  - `searchJadeByCitation()` function: resolves jade.io articles by neutral citation
  - `deduplicateResults()` function: deduplicates by neutral citation, preferring jade.io
  - `mergeSearchResults()` function: merges results from AustLII and jade.io
- `includeJade` parameter on `search_cases` and `search_legislation` tools for multi-source merging
- Maximum 5 concurrent jade.io article resolutions to avoid overwhelming the server
- Graceful fallback: if jade.io resolution fails, AustLII results are still returned
- ESLint and Prettier for code quality enforcement
- SECURITY.md for responsible vulnerability disclosure
- CONTRIBUTING.md with development guidelines
- CHANGELOG.md for tracking changes
- Comprehensive project improvement documentation
- Linting and formatting scripts in package.json
- Test coverage support configuration
- Unit tests for AustLII search internals (isCaseNameQuery, determineSortMode, boostTitleMatches, extractReportedCitation)
- Unit tests for configuration module

### Changed

- Updated dependencies to address security vulnerabilities
- Enhanced documentation structure
- Migrated ESLint configuration from `.eslintrc.json` to `eslint.config.mjs` for ESLint v9 compatibility
- Services now use custom error classes (AustLiiError, NetworkError, ParseError, OcrError) instead of generic Error
- Document fetcher now uses structured logger instead of console.warn/error
- Document fetcher now uses config and constants modules instead of hardcoded values
- Exported internal AustLII functions for testability

### Security

- Fixed 3 HIGH severity vulnerabilities in dependencies
- Added npm audit to development workflow

## [0.1.0] - 2024-12-01

### Added

- Initial MVP release
- AustLII search integration for Australian and NZ legal research
- Intelligent search relevance with auto-detection
- Case law search with jurisdiction filtering
- Legislation search capabilities
- Smart query detection (case names vs topic searches)
- Automatic sort mode selection (relevance vs date)
- Title matching boost for case name queries
- Full-text document retrieval (HTML and PDF)
- OCR support for scanned PDFs using Tesseract
- jade.io URL support for document fetching
- Citation extraction (neutral and reported formats)
- Paragraph number preservation for pinpoint citations
- Multiple output formats (JSON, text, markdown, HTML)
- Pagination support with offset parameter
- Multiple search methods (title, phrase, boolean, etc.)
- Comprehensive documentation (README, AGENTS, ROADMAP)
- Real-world integration tests (18 test scenarios)
- GitHub Actions CI/CD workflows
- TypeScript strict mode configuration
- MIT License

### Features

- **Search Tools**:
  - `search_cases` - Search Australian and NZ case law
  - `search_legislation` - Search legislation
  - `fetch_document_text` - Retrieve full text with OCR fallback

- **Jurisdictions Supported**:
  - Commonwealth (cth/federal)
  - All Australian states and territories (VIC, NSW, QLD, SA, WA, TAS, NT, ACT)
  - New Zealand (nz)

- **Smart Search**:
  - Auto-detects case name queries vs topic searches
  - Relevance sorting for specific case lookups
  - Date sorting for recent case research
  - Title matching boost for better results

- **Citation Support**:
  - Neutral citations: `[2024] HCA 26`
  - Reported citations: `(2024) 350 ALR 123`
  - Paragraph numbers: `[N]` format preservation

### Technical

- Node.js 18+ required
- TypeScript 5.9+ with strict mode
- Model Context Protocol (MCP) SDK 1.19+
- Vitest for testing
- Cheerio for HTML parsing
- Axios for HTTP requests
- Tesseract OCR for scanned PDFs

### Documentation

- Comprehensive README with usage examples
- AGENTS.md for AI-assisted development
- ROADMAP.md for planned features
- Architecture documentation

### Testing

- 18 integration test scenarios
- Real-world API testing against AustLII
- Coverage of main use cases:
  - Negligence and duty of care
  - Contract disputes
  - Constitutional law
  - Employment law
  - Property and land law

[Unreleased]: https://github.com/russellbrenner/auslaw-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/russellbrenner/auslaw-mcp/releases/tag/v0.1.0
