import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

/**
 * No React Testing Library in this repo (see login-magic-link-config.test.ts
 * for the same constraint/rationale), so this checks the login page source
 * directly for the properties that matter here:
 *  - Turnstile is wired into the register flow only, never into
 *    handleSignIn/handleMagicLink (normal login/magic-link stay untouched).
 *  - The post-registration feedback query param carries no sensitive data.
 */
describe("login page — Turnstile scope and persistent feedback", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "app", "login", "page.tsx"),
    "utf8"
  );

  function extractFunctionBody(name: string): string {
    const start = source.indexOf(`const ${name} = async () => {`);
    expect(start, `${name} not found in login page source`).toBeGreaterThan(-1);
    // Find the matching closing brace for this arrow function by brace counting.
    let depth = 0;
    let i = source.indexOf("{", start);
    const bodyStart = i;
    for (; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    return source.slice(bodyStart, i + 1);
  }

  it("handleSignIn (normal password login) never references Turnstile", () => {
    const body = extractFunctionBody("handleSignIn");
    expect(body).not.toMatch(/turnstile/i);
  });

  it("handleMagicLink never references Turnstile", () => {
    const body = extractFunctionBody("handleMagicLink");
    expect(body).not.toMatch(/turnstile/i);
  });

  it("handleRegister requires a Turnstile token before submitting", () => {
    const body = extractFunctionBody("handleRegister");
    expect(body).toMatch(/turnstileToken/);
    expect(body).toMatch(/turnstile_token/);
  });

  it("the post-registration redirect carries only a plain status flag, no sensitive data", () => {
    const body = extractFunctionBody("handleRegister");
    const replaceStateCall = body.match(/window\.history\.replaceState\([^)]*\)/);
    expect(replaceStateCall).not.toBeNull();
    const call = replaceStateCall![0];
    expect(call).toContain("request=received");
    expect(call).not.toMatch(/identifier|password|turnstileToken|email/i);
  });

  it("the mount effect renders a persistent message when request=received is present in the URL", () => {
    expect(source).toMatch(/searchParams\.get\("request"\)\s*===\s*"received"/);
  });
});
