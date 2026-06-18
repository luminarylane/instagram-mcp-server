import { describe, it, expect } from "vitest";
import { textResult, errorResult, senseResult } from "./response.js";

describe("textResult", () => {
  it("wraps data as JSON text content", () => {
    const result = textResult({ foo: "bar" });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(JSON.parse(result.content[0].text)).toEqual({ foo: "bar" });
  });

  it("handles null and undefined values", () => {
    const result = textResult({ a: null, b: undefined });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.a).toBeNull();
    expect(parsed.b).toBeUndefined();
  });
});

describe("errorResult", () => {
  it("sets isError to true", () => {
    const result = errorResult("TEST_ERROR", "Something went wrong");
    expect(result.isError).toBe(true);
  });

  it("includes error and message in JSON", () => {
    const result = errorResult("TEST_ERROR", "Something went wrong");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("TEST_ERROR");
    expect(parsed.message).toBe("Something went wrong");
  });

  it("merges meta fields into the response", () => {
    const result = errorResult("TEST_ERROR", "msg", {
      action: "RETRY_ONCE",
      statusCode: 429,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.action).toBe("RETRY_ONCE");
    expect(parsed.statusCode).toBe(429);
  });
});

describe("senseResult", () => {
  it("wraps content with EXTCONTENT markers", () => {
    const result = senseResult({ data: "test" }, "Instagram");
    const text = result.content[0].text;
    expect(text).toMatch(/<<<EXTCONTENT_[a-f0-9]+>>>/);
    expect(text).toMatch(/<<\/EXTCONTENT_[a-f0-9]+>>>/);
    expect(text).toContain("Untrusted content from Instagram");
  });

  it("produces matching open/close hashes", () => {
    const result = senseResult({}, "Instagram");
    const text = result.content[0].text;
    const openMatch = text.match(/<<<EXTCONTENT_([a-f0-9]+)>>>/);
    const closeMatch = text.match(/<<<\/EXTCONTENT_([a-f0-9]+)>>>/);
    expect(openMatch).toBeTruthy();
    expect(closeMatch).toBeTruthy();
    expect(openMatch![1]).toBe(closeMatch![1]);
  });

  it("generates unique hashes across calls", () => {
    const r1 = senseResult({}, "Instagram");
    const r2 = senseResult({}, "Instagram");
    const h1 = r1.content[0].text.match(/<<<EXTCONTENT_([a-f0-9]+)>>>/)![1];
    const h2 = r2.content[0].text.match(/<<<EXTCONTENT_([a-f0-9]+)>>>/)![1];
    expect(h1).not.toBe(h2);
  });

  it("contains valid JSON data between markers", () => {
    const data = { posts: [{ id: "1", text: "hello" }] };
    const result = senseResult(data, "Instagram");
    const text = result.content[0].text;
    // Extract JSON between markers
    const lines = text.split("\n");
    const jsonLines = lines.slice(2, -1).join("\n");
    expect(JSON.parse(jsonLines)).toEqual(data);
  });
});
