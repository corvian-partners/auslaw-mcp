# "Cited By" Citator Feature Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `search_citing_cases` MCP tool that returns cases citing a given case, powered by jade.io's LeftoverRemoteService.search GWT-RPC endpoint.

**Architecture:** New `buildCitatorSearchRequest()` and `parseCitatorResponse()` functions in `jade-gwt.ts`; new `searchCitingCases()` orchestrator in `jade.ts`; new MCP tool registration in `index.ts`. The citator needs a "citable ID" (distinct from the article ID), extracted from the proposeCitables response. The response uses `.concat()` array joining (unlike proposeCitables which is a single JSON array), requiring a specialised parser.

**Tech Stack:** TypeScript, Vitest, existing jade-gwt utilities (GWT encoding/decoding, rate limiter, session cookie auth)

---

## Background: Three Different IDs in jade.io

jade.io uses three distinct numeric identifiers per case:

| ID Type | Range | Example (Mabo [1992] HCA 23) | Used For |
|---------|-------|------------------------------|----------|
| Article ID | 100-2M | 67683 | URLs: `jade.io/article/67683` |
| Record ID | 10M+ | 2323422 | Internal bridge section lookups |
| Citable ID | 2M-10M | 2463606 (GWT: `JZd2`) | Citator search input |

The existing `search_cases` tool resolves article IDs (for direct URLs). The citator needs citable IDs. Both appear in the proposeCitables response, but in different positions.

## Key Evidence (from HAR analysis, 2026-03-03)

### LeftoverRemoteService.search

- **Strong name:** `CCB23EABE2EF1A4CA63F2E243C979468` (code has stale `EF3980F48D304DEE936E425DA22C0A1D`)
- **Input:** GWT-encoded citable ID (e.g., `JZd2` = 2463606 for Mabo [1992] HCA 23)
- **Response format:** `//OK[segment1].concat([segment2_including_string_table, 4, 7])`
  - Segment 1: up to 32768 elements (GWT array size limit)
  - Segment 2: remainder + string table
  - No `"+"` string concatenation (unlike proposeCitables)
- **String table:** 1647 entries for Mabo (27 unique neutral citations = one page of results)
- **Total results:** 695 citing cases for Mabo; response contains one page (~27 results)
- **Case record data:** Case name, neutral citation (0-padded and non-0-padded forms), reported citations, court name, panels, judges, catchwords, summary, page references (where target is cited), article source URLs (`https://jade.io/article/src/{id}/0`)
- **Bridge section:** 244 GWT article IDs in last 10% of flat array (same pattern as proposeCitables)

### Citable ID Location in proposeCitables

- Citable IDs appear in the flat array at 15-25% position (the "citable objects" section)
- Range: 2M-10M (GWT strings, 3-4 characters)
- ~15 citable IDs per response (one per search result)
- Confirmed: `JZd2` = 2463606 at flat[3710] in Mabo proposeCitables (4 independent HAR captures)
- The citable ID is preceded by a numeric value (e.g., 5928) that may be a structural marker

### Request Body Template (from HAR)

The LeftoverRemoteService.search request is complex (35 string table entries, ~2700 bytes). The template includes:
- CitationSearchDefinition with criteria groups
- CitableSearchDefinition with result type
- IgnoreSelfCitationsCriterion (boolean)
- IgnoreShortCitationsCriterion (boolean)
- EffectiveDateDescendingOrder (sort order)
- The citable ID is embedded as a GWT-encoded string at a known position

HAR file for reference: `/tmp/jade-citator.har` (entry 6 = LeftoverRemoteService.search)

---

## Task 1: Fix LEFTOVER_STRONG_NAME

**Files:**
- Modify: `src/services/jade-gwt.ts:96`
- Modify: `docs/jade-gwt-protocol.md:18`

**Step 1: Update the constant**

In `src/services/jade-gwt.ts`, change:
```typescript
export const LEFTOVER_STRONG_NAME = "EF3980F48D304DEE936E425DA22C0A1D";
```
to:
```typescript
export const LEFTOVER_STRONG_NAME = "CCB23EABE2EF1A4CA63F2E243C979468";
```
Update the comment date to 2026-03-03.

**Step 2: Update docs**

In `docs/jade-gwt-protocol.md`, update the LeftoverRemoteService strong name in the service table.

**Step 3: Run build**

Run: `npm run build`
Expected: PASS (no runtime change, just a constant)

**Step 4: Commit**

```bash
git add src/services/jade-gwt.ts docs/jade-gwt-protocol.md
git commit -m "fix: update LeftoverRemoteService strong name from 2026-03-03 HAR"
```

---

## Task 2: Save citator response fixture

**Files:**
- Create: `src/test/fixtures/citator-mabo.txt`
- Modify: `src/test/fixtures/index.ts`

**Step 1: Extract and save fixture**

Write a script to extract the LeftoverRemoteService.search response from `/tmp/jade-citator.har` (entry 6), base64-decode it, and save as the fixture. The fixture is the raw GWT-RPC response text (starts with `//OK`).

```bash
node -e "
const har = JSON.parse(require('fs').readFileSync('/tmp/jade-citator.har', 'utf-8'));
const entries = har.log.entries.filter(e => e.request.url.includes('jadeService.do'));
const decoded = Buffer.from(entries[6].response.content.text, 'base64').toString('utf-8');
require('fs').writeFileSync('src/test/fixtures/citator-mabo.txt', decoded);
console.log('Wrote', decoded.length, 'bytes');
"
```

**Step 2: Add fixture export**

In `src/test/fixtures/index.ts`, add:
```typescript
export const CITATOR_MABO = readFileSync(
  join(__dirname, "citator-mabo.txt"),
  "utf-8",
);
```

**Step 3: Verify fixture loads**

Run: `npx vitest run src/test/unit/jade-gwt.test.ts`
Expected: PASS (existing tests still work, new export is unused)

**Step 4: Commit**

```bash
git add src/test/fixtures/citator-mabo.txt src/test/fixtures/index.ts
git commit -m "test: add LeftoverRemoteService citator response fixture for Mabo"
```

---

## Task 3: Implement `.concat()` response parser

The citator response uses `//OK[...].concat([...])` format when the flat array exceeds 32768 elements. The existing `parseProposeCitablesResponse` uses `JSON.parse()` directly, which fails on `.concat()` responses.

**Files:**
- Modify: `src/services/jade-gwt.ts` (new exported function)
- Create: test cases in `src/test/unit/jade-gwt.test.ts`

**Step 1: Write the failing test**

```typescript
describe("parseGwtConcatResponse", () => {
  it("parses a simple //OK response with no .concat()", () => {
    const resp = '//OK[1,2,3,["st1","st2"],4,7]';
    const { flatArray, stringTable } = parseGwtConcatResponse(resp);
    expect(flatArray).toEqual([1, 2, 3]);
    expect(stringTable).toEqual(["st1", "st2"]);
  });

  it("parses a response with one .concat() segment", () => {
    const resp = '//OK[1,2].concat([3,4,["st1","st2"],4,7])';
    const { flatArray, stringTable } = parseGwtConcatResponse(resp);
    expect(flatArray).toEqual([1, 2, 3, 4]);
    expect(stringTable).toEqual(["st1", "st2"]);
  });

  it("handles GWT string concatenation within segments", () => {
    const resp = '//OK[1,"foo"+"bar",["st"+"ring"],4,7]';
    const { flatArray, stringTable } = parseGwtConcatResponse(resp);
    expect(flatArray).toEqual([1, "foobar"]);
    expect(stringTable).toEqual(["string"]);
  });

  it("parses the real Mabo citator fixture", () => {
    const fixture = readFixture("citator-mabo.txt");
    const { flatArray, stringTable } = parseGwtConcatResponse(fixture);
    expect(flatArray.length).toBeGreaterThan(40000);
    expect(stringTable.length).toBeGreaterThan(1000);
    // Known string table content
    expect(stringTable.some(s =>
      typeof s === "string" && s.includes("CitableSearchResults")
    )).toBe(true);
  });

  it("throws on //EX exception response", () => {
    expect(() => parseGwtConcatResponse("//EX error")).toThrow(/exception/i);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/test/unit/jade-gwt.test.ts -t "parseGwtConcatResponse"`
Expected: FAIL (function not defined)

**Step 3: Implement the parser**

In `src/services/jade-gwt.ts`:

```typescript
/**
 * Parses a GWT-RPC response that may use .concat() for array joining.
 *
 * Large GWT responses split the outer array into multiple segments joined
 * with .concat() when the element count exceeds 32768 (GWT array limit):
 *
 *   //OK[seg1...].concat([seg2...]).concat([seg3..., [string_table], 4, 7])
 *
 * This function handles both simple //OK[...] and .concat() formats.
 * GWT string concatenation ("+"") within segments is also handled.
 *
 * @returns flatArray (all elements before the trailing [string_table, typeCount, magic])
 *          and stringTable (the nested array third-from-last in the combined result)
 */
export function parseGwtConcatResponse(
  responseText: string,
): { flatArray: unknown[]; stringTable: string[] } {
  if (responseText.startsWith("//EX")) {
    throw new Error("jade.io GWT-RPC server returned an exception response");
  }
  if (!responseText.startsWith("//OK")) {
    throw new Error(
      `Unexpected GWT-RPC response format: ${responseText.substring(0, 50)}`,
    );
  }

  const stripped = responseText.slice(4);
  const segments = stripped.split(".concat(");

  const allArrays: unknown[][] = [];
  for (let i = 0; i < segments.length; i++) {
    let seg = segments[i]!;

    // Remove trailing close-parens from .concat() nesting
    if (i > 0) {
      let trailingParens = 0;
      for (let j = seg.length - 1; j >= 0; j--) {
        if (seg[j] === ")") trailingParens++;
        else break;
      }
      seg = seg.substring(0, seg.length - trailingParens);
    }

    // Handle GWT string concatenation
    seg = seg.replace(/"\+"/g, "");

    const parsed: unknown = JSON.parse(seg);
    if (!Array.isArray(parsed)) {
      throw new Error(`GWT segment ${i} is not an array`);
    }
    allArrays.push(parsed);
  }

  const fullArray = allArrays.reduce<unknown[]>((a, b) => a.concat(b), []);

  if (fullArray.length < 4) {
    return { flatArray: [], stringTable: [] };
  }

  const stringTable = fullArray[fullArray.length - 3];
  if (!Array.isArray(stringTable)) {
    return { flatArray: fullArray, stringTable: [] };
  }

  // Flat array is everything before the trailing [stringTable, typeCount, magic]
  const flatArray = fullArray.slice(0, fullArray.length - 3);

  return { flatArray, stringTable: stringTable as string[] };
}
```

**Step 4: Run tests**

Run: `npx vitest run src/test/unit/jade-gwt.test.ts -t "parseGwtConcatResponse"`
Expected: PASS

**Step 5: Commit**

```bash
git add src/services/jade-gwt.ts src/test/unit/jade-gwt.test.ts
git commit -m "feat: add parseGwtConcatResponse for .concat() GWT responses"
```

---

## Task 4: Implement citator response parser

Parse the LeftoverRemoteService.search response to extract citing case records.

**Files:**
- Modify: `src/services/jade-gwt.ts` (new types and function)
- Add tests to `src/test/unit/jade-gwt.test.ts`

**Step 1: Define the CitingCase type**

```typescript
/** A case that cites the target case, extracted from a citator response */
export interface CitingCase {
  /** Case name (e.g., "Stuart v South Australia") */
  caseName: string;
  /** Neutral citation (e.g., "[2025] HCA 12") */
  neutralCitation: string;
  /** Reported citation if available (e.g., "422 ALR 279") */
  reportedCitation?: string;
  /** jade.io article ID if extractable from response */
  articleId?: number;
  /** jade.io article URL (direct or search fallback) */
  jadeUrl: string;
  /** Court name (e.g., "Federal Court of Australia") */
  court?: string;
}
```

**Step 2: Write the failing test**

```typescript
describe("parseCitatorResponse", () => {
  it("extracts citing cases from the Mabo citator fixture", () => {
    const fixture = readFixture("citator-mabo.txt");
    const { results, totalCount } = parseCitatorResponse(fixture);
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(30); // one page
  });

  it("extracts neutral citations for citing cases", () => {
    const fixture = readFixture("citator-mabo.txt");
    const { results } = parseCitatorResponse(fixture);
    const cits = results.map(r => r.neutralCitation);
    // Known citations from string table analysis
    expect(cits).toContain("[2025] HCA 12");
    expect(cits).toContain("[2025] HCA 32");
  });

  it("extracts case names for citing cases", () => {
    const fixture = readFixture("citator-mabo.txt");
    const { results } = parseCitatorResponse(fixture);
    const stuart = results.find(r => r.neutralCitation === "[2025] HCA 12");
    expect(stuart).toBeDefined();
    expect(stuart!.caseName).toContain("Stuart");
  });

  it("extracts article IDs from article source URLs", () => {
    const fixture = readFixture("citator-mabo.txt");
    const { results } = parseCitatorResponse(fixture);
    const stuart = results.find(r => r.neutralCitation === "[2025] HCA 12");
    expect(stuart?.articleId).toBe(1127773);
  });

  it("returns totalCount reflecting the full result set", () => {
    const fixture = readFixture("citator-mabo.txt");
    const { totalCount } = parseCitatorResponse(fixture);
    expect(totalCount).toBe(695); // known from citator UI
  });

  it("sets jadeUrl to direct article URL when article ID is available", () => {
    const fixture = readFixture("citator-mabo.txt");
    const { results } = parseCitatorResponse(fixture);
    const stuart = results.find(r => r.neutralCitation === "[2025] HCA 12");
    expect(stuart?.jadeUrl).toBe("https://jade.io/article/1127773");
  });

  it("throws on //EX exception response", () => {
    expect(() => parseCitatorResponse("//EX error")).toThrow(/exception/i);
  });
});
```

**Step 3: Run test to verify it fails**

Run: `npx vitest run src/test/unit/jade-gwt.test.ts -t "parseCitatorResponse"`
Expected: FAIL

**Step 4: Implement the parser**

Strategy:
1. Use `parseGwtConcatResponse()` to get flatArray + stringTable
2. Extract neutral citations from string table (non-0-padded, matching `/^\[\d{4}\]\s+[A-Z]/`)
3. For each neutral citation, scan backward in string table for case name (containing " v ")
4. Scan for article source URLs (`jade.io/article/src/{id}/`) in the flat array to build citation-to-articleId mapping
5. Search for totalCount (695) by looking for the value at known structural positions
6. Fall back to bridge section GWT article IDs for records without source URLs

```typescript
export function parseCitatorResponse(
  responseText: string,
): { results: CitingCase[]; totalCount: number } {
  const { flatArray, stringTable } = parseGwtConcatResponse(responseText);

  if (flatArray.length === 0 || stringTable.length === 0) {
    return { results: [], totalCount: 0 };
  }

  // Build a ref-to-flat-positions index for negative string table references
  const refToPositions = new Map<number, number[]>();
  for (let pos = 0; pos < flatArray.length; pos++) {
    const v = flatArray[pos];
    if (typeof v === "number" && v < 0) {
      const idx = Math.abs(v) - 1;
      const arr = refToPositions.get(idx);
      if (arr) arr.push(pos);
      else refToPositions.set(idx, [pos]);
    }
  }

  // Extract article IDs from article source URLs in the flat array
  const citToArticleId = new Map<string, number>();
  for (let i = 0; i < flatArray.length; i++) {
    const v = flatArray[i];
    if (typeof v === "number" && v < 0) {
      const stIdx = Math.abs(v) - 1;
      const s = stringTable[stIdx];
      if (typeof s !== "string") continue;
      const urlMatch = s.match(/\/article\/src\/(\d+)\//);
      if (!urlMatch) continue;
      const artId = parseInt(urlMatch[1]!, 10);
      // Find the nearest neutral citation in the surrounding flat array
      for (let j = i - 30; j <= i + 30; j++) {
        if (j < 0 || j >= flatArray.length) continue;
        const ref = flatArray[j];
        if (typeof ref !== "number" || ref >= 0) continue;
        const nearSt = stringTable[Math.abs(ref) - 1];
        if (typeof nearSt === "string" && /^\[\d{4}\]\s+[A-Z]/.test(nearSt) && nearSt.length < 40) {
          const normCit = nearSt.replace(/\s+0+(\d)/, " $1");
          if (!citToArticleId.has(normCit)) {
            citToArticleId.set(normCit, artId);
          }
        }
      }
    }
  }

  // Extract unique non-0-padded neutral citations from string table
  const seen = new Set<string>();
  const results: CitingCase[] = [];

  for (let i = 0; i < stringTable.length; i++) {
    const s = stringTable[i];
    if (typeof s !== "string") continue;
    if (!/^\[\d{4}\]\s+[A-Z]/.test(s) || s.length >= 40) continue;

    // Skip 0-padded versions (e.g., "[2025] HCA 0032")
    if (/\s+0\d/.test(s)) continue;
    // Skip the queried case's own citation (it appears in string table as a type ref)
    // Skip entries that look like type descriptors
    if (s.includes("/") || s.includes("$")) continue;

    const normCit = s.trim();
    if (seen.has(normCit)) continue;
    seen.add(normCit);

    // Scan backward in string table for case name
    let caseName: string | undefined;
    for (let j = i - 1; j >= Math.max(0, i - 50); j--) {
      const candidate = stringTable[j];
      if (typeof candidate !== "string") continue;
      if (candidate.includes(" v ") && candidate.length > 8 && candidate.length < 80
          && !candidate.startsWith("file:") && !candidate.startsWith("[")) {
        caseName = candidate;
        break;
      }
    }
    if (!caseName) continue;

    // Clean case name: remove trailing citation if embedded
    const citInName = caseName.match(/\s+\[\d{4}\]\s+[A-Z]+\s+\d+$/);
    if (citInName) {
      caseName = caseName.substring(0, citInName.index).trim();
    }

    const articleId = citToArticleId.get(normCit);
    const jadeUrl = articleId
      ? `https://jade.io/article/${articleId}`
      : `https://jade.io/search/${encodeURIComponent(normCit)}`;

    results.push({
      caseName,
      neutralCitation: normCit,
      articleId,
      jadeUrl,
    });
  }

  // Extract total count: search for the known pattern near end of flat array
  // Pattern: value appears at flat[N] where flat[N+1] is a type ref and flat[N+2]=0
  let totalCount = results.length;
  for (let i = flatArray.length - 100; i < flatArray.length; i++) {
    const v = flatArray[i];
    if (typeof v === "number" && v >= results.length && v <= 100000) {
      const next = flatArray[i + 1];
      if (typeof next === "number" && next < -100) {
        totalCount = v;
        break;
      }
    }
  }

  return { results, totalCount };
}
```

**Step 5: Run tests and iterate**

Run: `npx vitest run src/test/unit/jade-gwt.test.ts -t "parseCitatorResponse"`
Expected: PASS (may need adjustments based on fixture analysis)

**Step 6: Commit**

```bash
git add src/services/jade-gwt.ts src/test/unit/jade-gwt.test.ts
git commit -m "feat: add parseCitatorResponse for LeftoverRemoteService.search results"
```

---

## Task 5: Extract citable IDs from proposeCitables response

This is the critical connector: given a proposeCitables response that returns search results, extract the citable IDs (2M-10M range GWT strings) so they can be used as input to the citator.

**Files:**
- Modify: `src/services/jade-gwt.ts` (new exported function)
- Add tests to `src/test/unit/jade-gwt.test.ts`

**Step 1: Write the failing test**

```typescript
describe("extractCitableIds", () => {
  it("extracts citable IDs from the Mabo fixture", () => {
    const fixture = readFixture("propose-citables-mabo.txt");
    const { flatArray } = parseProposeCitablesResponse(fixture);
    const citableIds = extractCitableIds(flatArray);
    // JZd2 = 2463606 is the known citable ID for Mabo [1992] HCA 23
    expect(citableIds.some(c => c.citableId === 2463606)).toBe(true);
  });

  it("returns citable IDs in the 2M-10M range", () => {
    const fixture = readFixture("propose-citables-mabo.txt");
    const { flatArray } = parseProposeCitablesResponse(fixture);
    const citableIds = extractCitableIds(flatArray);
    expect(citableIds.length).toBeGreaterThan(0);
    for (const c of citableIds) {
      expect(c.citableId).toBeGreaterThanOrEqual(2_000_000);
      expect(c.citableId).toBeLessThanOrEqual(10_000_000);
    }
  });

  it("returns roughly one citable ID per search result", () => {
    const fixture = readFixture("propose-citables-mabo.txt");
    const { results, flatArray } = parseProposeCitablesResponse(fixture);
    const citableIds = extractCitableIds(flatArray);
    // Should have approximately as many citable IDs as results (including transcripts)
    expect(citableIds.length).toBeGreaterThanOrEqual(results.length);
    expect(citableIds.length).toBeLessThanOrEqual(results.length * 3);
  });

  it("returns empty array for empty flat array", () => {
    expect(extractCitableIds([])).toEqual([]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/test/unit/jade-gwt.test.ts -t "extractCitableIds"`
Expected: FAIL

**Step 3: Implement the function**

```typescript
export interface ExtractedCitableId {
  /** Position in the flat array */
  flatPos: number;
  /** Decoded citable ID (2M-10M range) */
  citableId: number;
  /** Original GWT-encoded string */
  gwtEncoded: string;
}

/**
 * Extracts citable IDs from the data section of a proposeCitables flat array.
 *
 * Citable IDs are GWT-encoded integers in the 2M-10M range, distinct from:
 * - Article IDs (100-2M): used in jade.io/article/{id} URLs
 * - Record IDs (10M+): internal bridge section lookups
 *
 * Citable IDs appear in the first 30% of the flat array (the "citable objects"
 * section), not in the bridge section (last 10%).
 *
 * These IDs are required as input to LeftoverRemoteService.search (citator).
 */
export function extractCitableIds(flatArray: unknown[]): ExtractedCitableId[] {
  const results: ExtractedCitableId[] = [];
  // Scan only the first 30% of the flat array (citable objects section)
  const scanEnd = Math.floor(flatArray.length * 0.3);

  for (let i = 0; i < scanEnd; i++) {
    const v = flatArray[i];
    if (typeof v !== "string" || v.length < 3 || v.length > 5) continue;
    if (!isGwtEncodedInt(v)) continue;

    const decoded = decodeGwtInt(v);
    if (decoded >= 2_000_000 && decoded <= 10_000_000) {
      results.push({ flatPos: i, citableId: decoded, gwtEncoded: v });
    }
  }

  return results;
}
```

**Step 4: Run tests**

Run: `npx vitest run src/test/unit/jade-gwt.test.ts -t "extractCitableIds"`
Expected: PASS

**Step 5: Commit**

```bash
git add src/services/jade-gwt.ts src/test/unit/jade-gwt.test.ts
git commit -m "feat: add extractCitableIds for citator search input extraction"
```

---

## Task 6: Build LeftoverRemoteService.search request

**Files:**
- Modify: `src/services/jade-gwt.ts` (new exported function)
- Add tests to `src/test/unit/jade-gwt.test.ts`

**Step 1: Write the failing test**

```typescript
describe("buildCitatorSearchRequest", () => {
  it("uses LeftoverRemoteService strong name", () => {
    const body = buildCitatorSearchRequest(2463606);
    expect(body).toContain("CCB23EABE2EF1A4CA63F2E243C979468");
    expect(body).toContain("LeftoverRemoteService");
  });

  it("embeds the GWT-encoded citable ID", () => {
    const body = buildCitatorSearchRequest(2463606);
    expect(body).toContain("JZd2"); // GWT encoding of 2463606
  });

  it("includes the search method name", () => {
    const body = buildCitatorSearchRequest(2463606);
    expect(body).toContain("search");
  });

  it("starts with GWT-RPC version header", () => {
    expect(buildCitatorSearchRequest(2463606)).toMatch(/^7\|0\|\d+\|/);
  });

  it("includes CitationSearchDefinition type", () => {
    const body = buildCitatorSearchRequest(2463606);
    expect(body).toContain("CitationSearchDefinition");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/test/unit/jade-gwt.test.ts -t "buildCitatorSearchRequest"`
Expected: FAIL

**Step 3: Implement the request builder**

Extract the request template from the HAR capture (entry 6 of `/tmp/jade-citator.har`). The template is the full GWT-RPC request body with the citable ID replaced by a placeholder.

```typescript
/**
 * Builds a GWT-RPC request body for LeftoverRemoteService.search.
 *
 * This performs a citation search ("who cites this case?") on jade.io.
 * The input is a citable ID (NOT an article ID), obtained from a
 * proposeCitables response via extractCitableIds().
 *
 * The request template was captured from jade.io's citator UI (2026-03-03 HAR).
 * It includes: CitationSearchDefinition, sort by effective date descending,
 * ignore self-citations, ignore short citations.
 *
 * @param citableId - The numeric citable ID for the target case
 * @returns GWT-RPC request body string
 */
export function buildCitatorSearchRequest(citableId: number): string {
  const gwtId = encodeGwtInt(citableId);
  // Template extracted from HAR (2026-03-03), with citable ID parameterised
  // String table has 35 entries; the citable ID is at position 6 (entry index 7)
  return (
    "7|0|35|" +
    `${JADE_MODULE_BASE}|` +
    `${LEFTOVER_STRONG_NAME}|` +
    "au.com.barnet.jade.cs.remote.LeftoverRemoteService|" +
    "search|" +
    "cc.alcina.framework.common.client.search.SearchDefinition/58859665|" +
    "au.com.barnet.jade.cs.trans.othersearch.citation.CitationSearchDefinition/955429335|" +
    "au.com.barnet.jade.cs.trans.othersearch.citable.CitableSearchDefinition$CitableSearchDefinitionResultType/866007608|" +
    "cc.alcina.framework.common.client.logic.domaintransform.lookup.LightSet/1335044906|" +
    "au.com.barnet.jade.cs.trans.othersearch.citation.CitableAndSectionsCriteriaGroup/1688548685|" +
    "cc.alcina.framework.common.client.logic.FilterCombinator/3213752301|" +
    "au.com.barnet.jade.cs.trans.othersearch.citation.CitableAndSectionsCriterion/4126754736|" +
    "au.com.barnet.jade.cs.trans.othersearch.citation.CitableCriterion/1545253367|" +
    "cc.alcina.framework.gwt.client.objecttree.search.StandardSearchOperator/2480038826|" +
    `${gwtId}|` +
    "au.com.barnet.jade.cs.trans.searchcriteria.JTextCriteriaGroup/1895870655|" +
    "au.com.barnet.jade.cs.trans.othersearch.citation.CitationsFilterCriteriaGroup/3683112863|" +
    "au.com.barnet.jade.cs.trans.othersearch.citation.IgnoreSelfCitationsCriterion/3894086720|" +
    "cc.alcina.framework.common.client.search.BooleanEnum/357020803|" +
    "au.com.barnet.jade.cs.trans.othersearch.citation.IgnoreShortCitationsCriterion/2514397111|" +
    "au.com.barnet.jade.cs.trans.othersearch.citation.CitationSourceFilterTypeEnumCriterion/4253248484|" +
    "au.com.barnet.jade.cs.csobjects.citables.CitationSourceFilterType/2049537451|" +
    "au.com.barnet.jade.cs.trans.searchcriteria.JournalCriteriaGroup/3343901624|" +
    "au.com.barnet.jade.cs.trans.othersearch.citation.CitationSourceCriteriaGroup/2323780731|" +
    "au.com.barnet.jade.cs.trans.searchcriteria.EffectiveDateCriteriaGroup/2950889875|" +
    "au.com.barnet.jade.cs.trans.searchcriteria.RetrievalDateCriteriaGroup/4014795601|" +
    "au.com.barnet.jade.cs.trans.searchcriteria.FirstExternalEnabledDateCriteriaGroup/311159311|" +
    "au.com.barnet.jade.cs.trans.othersearch.citation.CitationSearchDefinition$CitationOrderGroup1/1895249254|" +
    "au.com.barnet.jade.cs.trans.searchcriteria.order.JadeOrderCriterion$EffectiveDateDescendingOrder/1968635164|" +
    "cc.alcina.framework.common.client.search.SearchCriterion$Direction/3994719561|" +
    "au.com.barnet.jade.cs.trans.othersearch.citation.CitationSearchDefinition$CitationOrderGroup2/3936337759|" +
    "java.util.LinkedHashSet/95640124|" +
    "au.com.barnet.jade.cs.persistent.shared.CitableType/1576180844|" +
    "java.lang.String/2004016611|" +
    "au.com.barnet.jade.cs.trans.searchcriteria.order.JadeOrderCriterion$MostCitedDescendingOrder/2780126567|" +
    "1|2|3|4|1|5|6|7|0|0|0|0|0|0|0|0|0|8|0|9|10|1|11|12|13|1|14|0|0|0|0|0|0|" +
    "15|10|0|16|10|2|17|18|1|0|19|18|1|0|20|21|0|0|22|10|0|23|10|0|24|10|0|25|10|0|" +
    "26|10|0|27|0|28|29|0|0|0|0|0|30|0|31|4|32|0|32|1|32|2|32|3|0|0|33|0|27|0|34|29|0|35|0|0|"
  );
}
```

> **Note to implementer:** The trailing numeric section (after the last `|`) encodes the GWT serialisation of the search criteria objects. This was captured verbatim from the HAR. The citable ID appears at string table position 14 (the `gwtId` variable), referenced from the data section. Verify this against the actual HAR entry if tests fail.

**Step 4: Run tests**

Run: `npx vitest run src/test/unit/jade-gwt.test.ts -t "buildCitatorSearchRequest"`
Expected: PASS

**Step 5: Commit**

```bash
git add src/services/jade-gwt.ts src/test/unit/jade-gwt.test.ts
git commit -m "feat: add buildCitatorSearchRequest for LeftoverRemoteService.search"
```

---

## Task 7: Implement `searchCitingCases` orchestrator

**Files:**
- Modify: `src/services/jade.ts` (new exported function)
- Add tests to `src/test/unit/jade-search.test.ts`

**Step 1: Write the failing test**

```typescript
describe("searchCitingCases", () => {
  // These tests mock the HTTP layer
  it("returns citing cases for a known neutral citation", async () => {
    // Mock proposeCitables to return results with citable IDs
    // Mock citator search to return citing cases
    // Verify the orchestration works end-to-end
  });

  it("returns empty array when session cookie is not configured", async () => {
    // Temporarily unset config.jade.sessionCookie
    const results = await searchCitingCases("[1992] HCA 23");
    expect(results).toEqual({ results: [], totalCount: 0 });
  });
});
```

**Step 2: Implement the orchestrator**

In `src/services/jade.ts`:

```typescript
import {
  buildCitatorSearchRequest,
  parseCitatorResponse,
  extractCitableIds,
  type CitingCase,
} from "./jade-gwt.js";

/**
 * Searches for cases that cite a given case on jade.io.
 *
 * Flow:
 * 1. Call proposeCitables to find the target case and extract citable IDs
 * 2. Match the target case's citable ID
 * 3. Call LeftoverRemoteService.search with the citable ID
 * 4. Parse and return the citing cases
 *
 * @param query - Case identifier: neutral citation (e.g., "[1992] HCA 23")
 *   or case name (e.g., "Mabo v Queensland")
 * @returns Citing cases and total count, or empty if search fails
 */
export async function searchCitingCases(
  query: string,
): Promise<{ results: CitingCase[]; totalCount: number }> {
  const empty = { results: [], totalCount: 0 };

  if (!config.jade.sessionCookie) return empty;

  try {
    await jadeRateLimiter.throttle();

    // Step 1: Search for the target case
    const proposeBody = buildProposeCitablesRequest(query);
    const proposeUrl = `${config.jade.baseUrl}/jadeService.do`;
    const proposeResp = await axios.post(proposeUrl, proposeBody, {
      headers: {
        "Content-Type": "text/x-gwt-rpc; charset=UTF-8",
        "X-GWT-Module-Base": JADE_MODULE_BASE,
        "X-GWT-Permutation": JADE_PERMUTATION,
        Origin: "https://jade.io",
        Referer: "https://jade.io/",
        "User-Agent": config.jade.userAgent,
        Cookie: config.jade.sessionCookie,
      },
      timeout: config.jade.timeout,
      responseType: "text",
      maxContentLength: 5 * 1024 * 1024,
    });

    const { results: searchResults, flatArray } = parseProposeCitablesResponse(
      proposeResp.data as string,
    );
    if (searchResults.length === 0) return empty;

    // Step 2: Extract citable IDs and match to the best result
    const citableIds = extractCitableIds(flatArray);
    if (citableIds.length === 0) return empty;

    // Use the last citable ID in the data section as the primary match
    // (citable IDs appear in reverse order relative to descriptors)
    const citableId = citableIds[citableIds.length - 1]!.citableId;

    // Step 3: Call the citator
    await jadeRateLimiter.throttle();

    const citatorBody = buildCitatorSearchRequest(citableId);
    const citatorResp = await axios.post(proposeUrl, citatorBody, {
      headers: {
        "Content-Type": "text/x-gwt-rpc; charset=UTF-8",
        "X-GWT-Module-Base": JADE_MODULE_BASE,
        "X-GWT-Permutation": JADE_PERMUTATION,
        Origin: "https://jade.io",
        Referer: "https://jade.io/t/citator",
        "User-Agent": config.jade.userAgent,
        Cookie: config.jade.sessionCookie,
      },
      timeout: 30_000, // citator responses can be large (700KB+)
      responseType: "text",
      maxContentLength: 10 * 1024 * 1024,
    });

    // Step 4: Parse the citator response
    return parseCitatorResponse(citatorResp.data as string);
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.warn(
        `jade.io citator search failed${error.response?.status ? ` (HTTP ${error.response.status})` : ""} - returning empty results`,
      );
    } else {
      console.warn("jade.io citator search failed:", error instanceof Error ? error.message : String(error));
    }
    return empty;
  }
}
```

**Step 3: Run tests**

Run: `npx vitest run src/test/unit/jade-search.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/services/jade.ts src/test/unit/jade-search.test.ts
git commit -m "feat: add searchCitingCases orchestrator for citator flow"
```

---

## Task 8: Register `search_citing_cases` MCP tool

**Files:**
- Modify: `src/index.ts`

**Step 1: Add the tool registration**

In `src/index.ts`, add after the `search_by_citation` registration:

```typescript
import { searchCitingCases } from "./services/jade.js";

// ... inside main()

const searchCitingShape = {
  query: z.string().min(1, "Query cannot be empty.")
    .describe("Case to find citations for: neutral citation (e.g., '[1992] HCA 23') or case name (e.g., 'Mabo v Queensland')"),
  format: formatEnum.optional(),
};
const searchCitingParser = z.object(searchCitingShape);

server.registerTool(
  "search_citing_cases",
  {
    title: "Search Citing Cases",
    description:
      "Find cases that cite a given case (\"cited by\" / citator search). Input: a neutral citation or case name. Returns: list of citing cases with names, neutral citations, and jade.io URLs. Powered by jade.io's citator. Requires JADE_SESSION_COOKIE.",
    inputSchema: searchCitingShape,
  },
  async (rawInput) => {
    const { query, format } = searchCitingParser.parse(rawInput);
    const { results, totalCount } = await searchCitingCases(query);

    const formatted = results.map(r => ({
      title: r.caseName,
      neutralCitation: r.neutralCitation,
      reportedCitation: r.reportedCitation,
      url: r.jadeUrl,
      source: "jade" as const,
      type: "case" as const,
      articleId: r.articleId,
    }));

    return formatSearchResults(
      formatted.map(r => ({
        ...r,
        _meta: { totalCitingCases: totalCount, returnedCount: results.length },
      })),
      format ?? "json",
    );
  },
);
```

**Step 2: Run build and tests**

Run: `npm run build && npx vitest run src/test/unit/`
Expected: PASS

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: register search_citing_cases MCP tool"
```

---

## Task 9: Update documentation

**Files:**
- Modify: `docs/jade-gwt-protocol.md`
- Modify: `CLAUDE.md`

**Step 1: Add LeftoverRemoteService.search section to protocol docs**

Add a new section to `docs/jade-gwt-protocol.md` covering:
- Request format (template with citable ID)
- Response format (`.concat()` segments, string table structure)
- Citing case record structure
- Citable ID vs Article ID vs Record ID distinction
- HAR evidence table

**Step 2: Update CLAUDE.md**

Add `search_citing_cases` to the tool list and document the citator flow.

**Step 3: Commit**

```bash
git add docs/jade-gwt-protocol.md CLAUDE.md
git commit -m "docs: add LeftoverRemoteService citator protocol documentation"
```

---

## Verification

```bash
npm run build      # Clean compile
npx vitest run src/test/unit/   # All unit tests
npm run lint       # Lint passes
```

Live verification (requires JADE_SESSION_COOKIE):
```
search_citing_cases: query="[1992] HCA 23"
  -> Should return 20+ citing cases
  -> totalCount should be ~695
  -> Results should include Stuart v South Australia [2025] HCA 12

search_citing_cases: query="Kozarov v Victoria"
  -> Should return citing cases for the matched case
```

---

## Known Risks and Mitigations

### Risk 1: Citable ID matching (HIGH)

The citable ID extraction from proposeCitables maps the last citable ID to the first search result. This mapping is based on observed reverse-order correlation in Mabo responses, but is only confirmed for one ground-truth citable ID (2463606 for [1992] HCA 23).

**Mitigation:** If the wrong citable ID is used, the citator will return citations for a different case. The user will see obviously wrong results and can retry with a more specific query. A future improvement could validate the citator response (check that the queried citation appears in the response data).

### Risk 2: GWT-RPC template staleness (MEDIUM)

The `buildCitatorSearchRequest` template includes GWT type hashes (e.g., `SearchDefinition/58859665`) that may change on jade.io redeployment, independently of the strong name.

**Mitigation:** Same as existing proposeCitables: if the request fails with //EX, update the template from a fresh HAR capture. Document the update procedure in CLAUDE.md.

### Risk 3: Response parser fragility (MEDIUM)

The citator response parser relies on string table structure (neutral citations, case names at known relative positions). jade.io may change the serialisation order.

**Mitigation:** Unit tests with the fixture catch regressions. The parser fails gracefully (returns empty results, never crashes).

### Risk 4: Large response size (LOW)

Mabo's citator response is 702KB. Cases with more citations could be larger. The `.concat()` parser loads the entire response into memory.

**Mitigation:** `maxContentLength: 10MB` limit. GWT responses are efficient (mostly integers), so even 10,000 results should be under 5MB.

---

## Git Plan

Feature branch off main. Squash or keep granular commits per preference.

Commits:
1. `fix: update LeftoverRemoteService strong name` (Task 1)
2. `test: add citator response fixture` (Task 2)
3. `feat: add parseGwtConcatResponse` (Task 3)
4. `feat: add parseCitatorResponse` (Task 4)
5. `feat: add extractCitableIds` (Task 5)
6. `feat: add buildCitatorSearchRequest` (Task 6)
7. `feat: add searchCitingCases orchestrator` (Task 7)
8. `feat: register search_citing_cases MCP tool` (Task 8)
9. `docs: add citator protocol documentation` (Task 9)

Push to both `origin` and `gitea` after the feature is complete.
