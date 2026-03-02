import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import axios from "axios";
import { fileTypeFromBuffer } from "file-type";

vi.mock("file-type");
vi.mock("axios");

const mockConfig = vi.hoisted(() => ({
  jade: {
    userAgent: "test-agent",
    timeout: 5000,
    sessionCookie: undefined as string | undefined,
  },
  ocr: { language: "eng", oem: 1, psm: 3 },
  austlii: { searchBase: "", referer: "", userAgent: "", timeout: 5000 },
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
    mockConfig.jade.sessionCookie = undefined;
  });

  it("throws immediately for jade.io URLs without making any HTTP request", async () => {
    // jade.io is a GWT SPA; HTTP fetch only returns a JS bootstrap shell, not judgment text.
    // We reject early so callers get a clear error rather than empty content.
    await expect(fetchDocumentText("https://jade.io/article/68901")).rejects.toThrow(
      /fetch_document_text does not support jade\.io/i,
    );
    expect(axios.get).not.toHaveBeenCalled();
  });

  it("throws immediately for jade.io URLs regardless of session cookie config", async () => {
    mockConfig.jade.sessionCookie = "alcsessionid=abc123";

    await expect(fetchDocumentText("https://jade.io/article/12345")).rejects.toThrow(
      /GWT single-page application/i,
    );
    expect(axios.get).not.toHaveBeenCalled();
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
