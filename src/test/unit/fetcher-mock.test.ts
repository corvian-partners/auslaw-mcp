import { describe, it, expect, vi, beforeEach } from "vitest";
import { impersonateFetch } from "../../utils/impersonate-fetch.js";
import { fetchDocumentText } from "../../services/fetcher.js";
import { AUSTLII_JUDGMENT_HTML } from "../fixtures/index.js";

vi.mock("../../utils/impersonate-fetch.js", () => ({
  impersonateFetch: vi.fn(),
  warmupSession: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("file-type", () => ({
  fileTypeFromBuffer: vi.fn().mockResolvedValue(undefined),
}));

const mockedFetch = vi.mocked(impersonateFetch);

function mockResponse(body: string | Buffer, contentType: string, status = 200) {
  return {
    status,
    statusText: status === 200 ? "OK" : "",
    headers: { "content-type": contentType },
    data: typeof body === "string" ? Buffer.from(body) : body,
  };
}

describe("fetchDocumentText (mocked)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should reject non-AustLII URLs (e.g. jade.io) via the SSRF allowlist", async () => {
    // Only AustLII hosts are permitted — the URL guard rejects jade.io before
    // any network request is attempted.
    await expect(fetchDocumentText("https://jade.io/article/67401")).rejects.toThrow(
      /not in permitted/i,
    );
  });

  it("should extract text from HTML content", async () => {
    mockedFetch.mockResolvedValue(mockResponse(AUSTLII_JUDGMENT_HTML, "text/html", 200));

    const result = await fetchDocumentText(
      "https://www.austlii.edu.au/au/cases/cth/HCA/2024/1.html",
    );
    expect(result.text).toBeTruthy();
    expect(result.text).toContain("Smith v Jones");
  });

  it("should preserve paragraph numbers [N] in extracted text", async () => {
    mockedFetch.mockResolvedValue(mockResponse(AUSTLII_JUDGMENT_HTML, "text/html", 200));

    const result = await fetchDocumentText(
      "https://www.austlii.edu.au/au/cases/cth/HCA/2024/1.html",
    );
    expect(result.text).toMatch(/\[1\]/);
    expect(result.text).toMatch(/\[4\]/);
  });

  it("should set correct metadata fields", async () => {
    mockedFetch.mockResolvedValue(mockResponse(AUSTLII_JUDGMENT_HTML, "text/html", 200));

    const result = await fetchDocumentText(
      "https://www.austlii.edu.au/au/cases/cth/HCA/2024/1.html",
    );
    expect(result.contentType).toBe("text/html");
    expect(result.sourceUrl).toBe("https://www.austlii.edu.au/au/cases/cth/HCA/2024/1.html");
    expect(result.metadata).toBeDefined();
    expect(result.metadata!.contentLength).toBeDefined();
    expect(result.metadata!.contentType).toBe("text/html");
  });

  it("should set ocrUsed to false for HTML content", async () => {
    mockedFetch.mockResolvedValue(mockResponse(AUSTLII_JUDGMENT_HTML, "text/html", 200));

    const result = await fetchDocumentText(
      "https://www.austlii.edu.au/au/cases/cth/HCA/2024/1.html",
    );
    expect(result.ocrUsed).toBe(false);
  });

  it("should handle plain text content type", async () => {
    const plainText = "This is a plain text legal document.";
    mockedFetch.mockResolvedValue(mockResponse(plainText, "text/plain", 200));

    const result = await fetchDocumentText(
      "https://www.austlii.edu.au/au/cases/cth/HCA/2024/doc.txt",
    );
    expect(result.text).toBe(plainText);
    expect(result.contentType).toBe("text/plain");
    expect(result.ocrUsed).toBe(false);
  });

  it("should throw on axios failure", async () => {
    mockedFetch.mockRejectedValue(new Error("Connection refused"));

    await expect(
      fetchDocumentText("https://www.austlii.edu.au/au/cases/cth/HCA/2024/1.html"),
    ).rejects.toThrow();
  });

  it("should preserve cleaned HTML in response.html for HTML content", async () => {
    mockedFetch.mockResolvedValue(mockResponse(AUSTLII_JUDGMENT_HTML, "text/html", 200));

    const result = await fetchDocumentText(
      "https://www.austlii.edu.au/au/cases/cth/HCA/2024/1.html",
    );
    expect(result.html).toBeDefined();
    expect(result.html).toContain("<h1>");
    expect(result.html).toContain("Smith v Jones");
    expect(result.html).not.toContain("<script");
    expect(result.html).not.toContain("<style");
    expect(result.html).not.toContain("<nav");
  });

  it("should not set html field for plain text content", async () => {
    const plainText = "This is a plain text legal document.";
    mockedFetch.mockResolvedValue(mockResponse(plainText, "text/plain", 200));

    const result = await fetchDocumentText(
      "https://www.austlii.edu.au/au/cases/cth/HCA/2024/doc.txt",
    );
    expect(result.html).toBeUndefined();
  });

  it("should throw for unsupported content type", async () => {
    mockedFetch.mockResolvedValue(mockResponse("binary data", "application/octet-stream", 200));

    await expect(
      fetchDocumentText("https://www.austlii.edu.au/au/cases/cth/HCA/2024/file.bin"),
    ).rejects.toThrow();
  });
});
