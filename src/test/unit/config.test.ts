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
});
