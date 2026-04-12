import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import axios from "axios";
import { fileTypeFromBuffer } from "file-type";

vi.mock("file-type");
vi.mock("axios");

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
    vi.mocked(axios.isAxiosError).mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws for jade.io URLs (no longer supported)", async () => {
    await expect(fetchDocumentText("https://jade.io/article/68901")).rejects.toThrow(
      /jade\.io.*(?:no longer|not) supported/i,
    );
    expect(axios.get).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
  });

  it("extracts paragraph blocks from AustLII HTML with [N] markers", async () => {
    const html = `<html><body>
      <p>[1] First paragraph text here.</p>
      <p>[2] Second paragraph about duty of care.</p>
      <p>[3] Third paragraph concluding.</p>
    </body></html>`;

    vi.mocked(axios.get).mockResolvedValueOnce({
      data: Buffer.from(html),
      headers: { "content-type": "text/html" },
      status: 200,
    });

    const result = await fetchDocumentText("https://www.austlii.edu.au/case");
    expect(result.paragraphs).toBeDefined();
    const paras = result.paragraphs!;
    expect(paras.length).toBe(3);
    expect(paras[1]!.number).toBe(2);
    expect(paras[1]!.text).toContain("duty of care");
  });
});
