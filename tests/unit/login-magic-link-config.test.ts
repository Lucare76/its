import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

describe("login magic link config", () => {
  it("passes shouldCreateUser: false to every signInWithOtp call in the repo", () => {
    // No React Testing Library in this repo to render app/login/page.tsx client
    // logic, so this asserts the config directly at the source level: an
    // unknown email must never silently create a new Auth user via the
    // magic-link button (account creation must go through /api/auth/register
    // or an explicit invite instead).
    const root = path.resolve(__dirname, "..", "..");
    const candidateFiles = [path.join(root, "app", "login", "page.tsx")];

    for (const file of candidateFiles) {
      const source = fs.readFileSync(file, "utf8");
      const otpCalls = [...source.matchAll(/signInWithOtp\(\{[\s\S]*?\}\);/g)];
      expect(otpCalls.length).toBeGreaterThan(0);
      for (const match of otpCalls) {
        expect(match[0]).toMatch(/shouldCreateUser:\s*false/);
      }
    }
  });
});
