import { describe, it, expect, vi, afterEach } from "vitest";
import { loadConfig } from "../../config.js";

describe("loadConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("loads LAWCITE_BASE_URL from env", () => {
    vi.stubEnv("LAWCITE_BASE_URL", "https://custom.lawcite.example.com/cgi-bin/LawCite");
    const cfg = loadConfig();
    expect(cfg.lawcite.baseUrl).toBe("https://custom.lawcite.example.com/cgi-bin/LawCite");
  });

  it("lawcite has default baseUrl when env var absent", () => {
    const cfg = loadConfig();
    expect(cfg.lawcite.baseUrl).toBe("https://www.austlii.edu.au/cgi-bin/LawCite");
  });

  it("citedBy.downloadLimit defaults to 5 when env var is non-numeric", () => {
    vi.stubEnv("AUSLAW_CITED_BY_DOWNLOAD_LIMIT", "abc");
    const cfg = loadConfig();
    expect(cfg.citedBy.downloadLimit).toBe(5);
  });

  it("citedBy.downloadLimit reads numeric env var correctly", () => {
    vi.stubEnv("AUSLAW_CITED_BY_DOWNLOAD_LIMIT", "10");
    const cfg = loadConfig();
    expect(cfg.citedBy.downloadLimit).toBe(10);
  });
});
