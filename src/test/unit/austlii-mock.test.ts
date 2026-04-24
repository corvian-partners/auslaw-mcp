import { describe, it, expect, vi, beforeEach } from "vitest";
import { impersonateFetch } from "../../utils/impersonate-fetch.js";
import { searchAustLii } from "../../services/austlii.js";
import { AUSTLII_SEARCH_HTML } from "../fixtures/index.js";

vi.mock("../../utils/impersonate-fetch.js", () => ({
  impersonateFetch: vi.fn(),
  warmupSession: vi.fn().mockResolvedValue(undefined),
}));
const mockedFetch = vi.mocked(impersonateFetch);

describe("searchAustLii (mocked)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFetch.mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/html" },
      data: Buffer.from(AUSTLII_SEARCH_HTML),
    });
  });

  it("should parse case results from HTML correctly", async () => {
    const results = await searchAustLii("negligence", { type: "case" });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.title).toBeTruthy();
      expect(r.url).toBeTruthy();
    }
  });

  it("should filter out journal articles (URLs with /journals/)", async () => {
    const results = await searchAustLii("negligence", { type: "case" });
    for (const r of results) {
      expect(r.url).not.toContain("/journals/");
    }
  });

  it("should filter out legislation results when searching for cases", async () => {
    const results = await searchAustLii("competition", { type: "case" });
    for (const r of results) {
      expect(r.url).toContain("/cases/");
      expect(r.url).not.toMatch(/\/legis\//);
    }
  });

  it("should extract neutral citations from titles", async () => {
    const results = await searchAustLii("Smith v Jones", { type: "case" });
    const withCitation = results.find((r) => r.neutralCitation);
    expect(withCitation).toBeDefined();
    expect(withCitation!.neutralCitation).toMatch(/\[\d{4}\]\s*[A-Z]+\s*\d+/);
  });

  it("should extract jurisdiction from URLs", async () => {
    const results = await searchAustLii("negligence", { type: "case" });
    const cthResult = results.find((r) => r.url.includes("/au/cases/cth/"));
    expect(cthResult).toBeDefined();
    expect(cthResult!.jurisdiction).toBe("cth");
  });

  it("should respect limit parameter", async () => {
    const results = await searchAustLii("negligence", { type: "case", limit: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("should set source to 'austlii' for all results", async () => {
    const results = await searchAustLii("negligence", { type: "case" });
    for (const r of results) {
      expect(r.source).toBe("austlii");
    }
  });

  it("should throw on network failure", async () => {
    mockedFetch.mockRejectedValue(new Error("Network Error"));

    await expect(searchAustLii("negligence", { type: "case" })).rejects.toThrow(
      "AustLII search failed",
    );
  });

  it("should build correct search URL with jurisdiction filter", async () => {
    await searchAustLii("negligence", { type: "case", jurisdiction: "vic" });
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const calledUrl = String(mockedFetch.mock.calls[0]?.[0] ?? "");
    expect(calledUrl).toContain("mask_path=au%2Fcases%2Fvic");
  });
});
