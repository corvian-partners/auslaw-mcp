import { describe, it, expect } from "vitest";
import {
  encodeGwtInt,
  buildGetInitialContentRequest,
  buildGetMetadataRequest,
  buildAvd2Request,
  parseGwtRpcResponse,
  parseAvd2Response,
  AVD2_STRONG_NAME,
} from "../../services/jade-gwt.js";

describe("encodeGwtInt", () => {
  it("encodes 0 as single character A", () => {
    expect(encodeGwtInt(0)).toBe("A");
  });

  it("encodes 67401 as QdJ (verified against captured HAR for article 67401)", () => {
    // 67401 = 16*64² + 29*64 + 9 = 65536+1856+9
    // Q=16, d=29, J=9 in GWT charset (A-Z=0-25, a-z=26-51, 0-9=52-61, $=62, _=63)
    expect(encodeGwtInt(67401)).toBe("QdJ");
  });

  it("encodes single-digit values (0-63) as one character", () => {
    expect(encodeGwtInt(63)).toBe("_");
    expect(encodeGwtInt(62)).toBe("$");
    expect(encodeGwtInt(25)).toBe("Z");
    expect(encodeGwtInt(26)).toBe("a");
  });

  it("encodes 64 as BA (first two-character value)", () => {
    expect(encodeGwtInt(64)).toBe("BA");
  });

  it("encodes 4096 as BAA (first three-character value)", () => {
    expect(encodeGwtInt(4096)).toBe("BAA");
  });

  it("throws for negative numbers", () => {
    expect(() => encodeGwtInt(-1)).toThrow();
  });

  it("throws for non-integer input", () => {
    expect(() => encodeGwtInt(1.5)).toThrow();
  });
});

describe("buildGetInitialContentRequest", () => {
  it("produces the exact known POST body for article 67401", () => {
    // Captured verbatim from Proxyman HAR export (jade.io_03-02-2026-13-48-33.har)
    const expected =
      "7|0|7|https://jade.io/au.com.barnet.jade.JadeClient/|16E3F568878E6841670449E07D95BA3E|" +
      "au.com.barnet.jade.cs.remote.JadeRemoteService|getInitialContent|" +
      "au.com.barnet.jade.cs.persistent.Jrl/728826604|au.com.barnet.jade.cs.persistent.Article|" +
      "java.util.ArrayList/4159755760|1|2|3|4|1|5|5|QdJ|A|0|A|A|6|0|";
    expect(buildGetInitialContentRequest(67401)).toBe(expected);
  });

  it("uses the GWT-encoded article ID", () => {
    const body = buildGetInitialContentRequest(68901);
    // 68901 should appear as GWT-encoded, not the raw integer
    expect(body).not.toContain("68901");
    expect(body).toContain(encodeGwtInt(68901));
  });

  it("starts with GWT-RPC version header", () => {
    expect(buildGetInitialContentRequest(12345)).toMatch(/^7\|0\|7\|/);
  });
});

describe("buildGetMetadataRequest", () => {
  it("produces the exact known POST body for article 67401", () => {
    // Captured verbatim from Proxyman HAR export
    const expected =
      "7|0|5|https://jade.io/au.com.barnet.jade.JadeClient/|16E3F568878E6841670449E07D95BA3E|" +
      "au.com.barnet.jade.cs.remote.JadeRemoteService|getArticleStructuredMetadata|J|" +
      "1|2|3|4|1|5|QdJ|";
    expect(buildGetMetadataRequest(67401)).toBe(expected);
  });

  it("uses the GWT-encoded article ID", () => {
    const body = buildGetMetadataRequest(99999);
    expect(body).not.toContain("99999");
    expect(body).toContain(encodeGwtInt(99999));
  });
});

describe("buildAvd2Request", () => {
  it("produces the exact known POST body for article 1182103", () => {
    // Captured from live SPA navigation interception (2026-03-02)
    // Article: AA v The Trustees of the Roman Catholic Church... [2026] HCA 2
    const expected =
      "7|0|10|https://jade.io/au.com.barnet.jade.JadeClient/|" +
      "E2F710F48F8237D9E1397729B9933A69|" +
      "au.com.barnet.jade.cs.remote.ArticleViewRemoteService|avd2Request|" +
      "au.com.barnet.jade.cs.csobjects.avd.Avd2Request/2068227305|" +
      "au.com.barnet.jade.cs.persistent.Jrl/728826604|" +
      "au.com.barnet.jade.cs.persistent.Article|" +
      "java.util.ArrayList/4159755760|" +
      "au.com.barnet.jade.cs.csobjects.avd.PhraseFrequencyParams/1915696367|" +
      "cc.alcina.framework.common.client.util.IntPair/1982199244|" +
      "1|2|3|4|1|5|5|A|A|0|6|EgmX|A|0|A|A|7|0|0|0|8|0|0|9|0|10|3|500|A|8|0|";
    expect(buildAvd2Request(1182103)).toBe(expected);
  });

  it("produces the correct body for article 67401", () => {
    const body = buildAvd2Request(67401);
    // Article ID 67401 = "QdJ" in GWT encoding
    expect(body).toContain("|QdJ|");
    expect(body).not.toContain("|67401|");
  });

  it("uses ArticleViewRemoteService strong name, not JadeRemoteService", () => {
    const body = buildAvd2Request(12345);
    expect(body).toContain(AVD2_STRONG_NAME);
    expect(body).toContain("ArticleViewRemoteService");
    expect(body).not.toContain("JadeRemoteService");
  });

  it("starts with GWT-RPC version header with 10 string table entries", () => {
    expect(buildAvd2Request(12345)).toMatch(/^7\|0\|10\|/);
  });
});

describe("parseAvd2Response", () => {
  it("extracts HTML from a response with string table", () => {
    // Simplified avd2Response format: [integers..., [string_table], 4, 7]
    const html = "<DIV><P>Judgment text</P></DIV>";
    const response = `//OK[0,-2,0,["SomeType/123","${html}"],4,7]`;
    expect(parseAvd2Response(response)).toBe(html);
  });

  it("handles unicode escape sequences in HTML", () => {
    const response = '//OK[0,-2,0,["Type/1","\\u003CDIV\\u003Econtent\\u003C/DIV\\u003E"],4,7]';
    expect(parseAvd2Response(response)).toBe("<DIV>content</DIV>");
  });

  it("joins GWT string concatenation markers before parsing", () => {
    // GWT splits long strings with "+" at the response level
    const html = "<DIV>long content here</DIV>";
    const half1 = html.substring(0, 15);
    const half2 = html.substring(15);
    const response = `//OK[0,["Type/1","${half1}"+"${half2}"],4,7]`;
    expect(parseAvd2Response(response)).toBe(html);
  });

  it("throws on //EX server exception response", () => {
    expect(() => parseAvd2Response("//EX WebException")).toThrow(/exception/i);
  });

  it("throws on unexpected format (no //OK prefix)", () => {
    expect(() => parseAvd2Response('{"json":"object"}')).toThrow();
  });

  it("throws when no HTML content found in string table", () => {
    const response = '//OK[0,["Type/1","Type/2"],4,7]';
    expect(() => parseAvd2Response(response)).toThrow(/no html content/i);
  });

  it("selects the longest string as HTML content", () => {
    const shortStr = "Type/123456";
    const html = "<DIV><P>[1] A paragraph of judgment text about negligence.</P></DIV>";
    const response = `//OK[0,["${shortStr}","${html}"],4,7]`;
    expect(parseAvd2Response(response)).toBe(html);
  });
});

describe("parseGwtRpcResponse", () => {
  it("extracts the HTML string from a getInitialContent response", () => {
    const responseText = '//OK[1,[],["<DIV>judgment text here</DIV>"],4,7]';
    expect(parseGwtRpcResponse(responseText)).toBe("<DIV>judgment text here</DIV>");
  });

  it("extracts JSON string from a getArticleStructuredMetadata response", () => {
    // GWT-RPC string table entries are JSON-encoded strings, so inner quotes are escaped.
    // This mirrors the actual wire format observed in the Proxyman HAR capture.
    const metadata = { "@context": "http://schema.org", name: "Test v Jones" };
    const responseText = `//OK[1,[],[${JSON.stringify(JSON.stringify(metadata))}],4,7]`;
    const result = parseGwtRpcResponse(responseText);
    expect(result).toContain("schema.org");
  });

  it("decodes unicode escape sequences (\\u003C becomes <)", () => {
    const responseText = '//OK[1,[],["\\u003CDIV\\u003E"],4,7]';
    expect(parseGwtRpcResponse(responseText)).toBe("<DIV>");
  });

  it("throws on //EX server exception response", () => {
    expect(() => parseGwtRpcResponse('//EX[{"type":"exception"}]')).toThrow(
      /server.*exception/i,
    );
  });

  it("throws on unexpected format (no //OK prefix)", () => {
    expect(() => parseGwtRpcResponse('{"json":"object"}')).toThrow();
  });

  it("throws when string table is empty", () => {
    expect(() => parseGwtRpcResponse("//OK[1,[],[],4,7]")).toThrow(/empty/i);
  });
});
