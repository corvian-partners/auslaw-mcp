import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { fileTypeFromBuffer } from "file-type";
import { impersonateFetch } from "../../utils/impersonate-fetch.js";

vi.mock("file-type");
vi.mock("../../utils/impersonate-fetch.js", () => ({
  impersonateFetch: vi.fn(),
  warmupSession: vi.fn().mockResolvedValue(undefined),
}));

const mockConfig = vi.hoisted(() => ({
  lawcite: {
    baseUrl: "https://www.austlii.edu.au/cgi-bin/LawCite",
    timeout: 15000,
  },
  ocr: { language: "eng", oem: 1, psm: 3 },
  austlii: { searchBase: "", referer: "", userAgent: "test-agent", timeout: 5000 },
  defaults: {
    searchLimit: 10,
    maxSearchLimit: 50,
    outputFormat: "json",
    sortBy: "auto",
  },
}));

vi.mock("../../config.js", () => ({ config: mockConfig }));

import { fetchDocumentText } from "../../services/fetcher.js";

describe("fetchDocumentText", () => {
  beforeEach(() => {
    vi.mocked(fileTypeFromBuffer).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects non-AustLII URLs (e.g. jade.io) via the SSRF guard", async () => {
    await expect(fetchDocumentText("https://jade.io/article/68901")).rejects.toThrow(
      /not in permitted/i,
    );
    expect(impersonateFetch).not.toHaveBeenCalled();
  });

  it("extracts paragraph blocks from AustLII HTML with [N] markers", async () => {
    const html = `<html><body>
      <p>[1] First paragraph text here.</p>
      <p>[2] Second paragraph about duty of care.</p>
      <p>[3] Third paragraph concluding.</p>
    </body></html>`;

    vi.mocked(impersonateFetch).mockResolvedValueOnce({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/html" },
      data: Buffer.from(html),
    });

    const result = await fetchDocumentText("https://www.austlii.edu.au/case");
    expect(result.paragraphs).toBeDefined();
    const paras = result.paragraphs!;
    expect(paras.length).toBe(3);
    expect(paras[1]!.number).toBe(2);
    expect(paras[1]!.text).toContain("duty of care");
  });
});
