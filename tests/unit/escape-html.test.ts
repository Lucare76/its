import { describe, it, expect } from "vitest";
import { escapeHtml } from "@/lib/server/escape-html";

describe("escapeHtml", () => {
  it("escapes ampersand", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("escapes < and >", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
  });

  it("escapes double quotes", () => {
    expect(escapeHtml('say "hello"')).toBe("say &quot;hello&quot;");
  });

  it("escapes single quotes", () => {
    expect(escapeHtml("it's fine")).toBe("it&#39;s fine");
  });

  it("neutralises a full XSS payload", () => {
    const payload = `<img src=x onerror="alert('xss')">`;
    const escaped = escapeHtml(payload);
    expect(escaped).not.toContain("<");
    expect(escaped).not.toContain(">");
    expect(escaped).not.toContain('"');
    expect(escaped).not.toContain("'");
  });

  it("returns empty string for null / undefined", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });

  it("converts numbers to string", () => {
    expect(escapeHtml(42)).toBe("42");
  });

  it("leaves plain text unchanged", () => {
    expect(escapeHtml("Hello World")).toBe("Hello World");
  });
});
