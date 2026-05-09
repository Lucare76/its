import nextVitals from "eslint-config-next/core-web-vitals";

/** @type {import("eslint").Linter.Config[]} */
const config = [
  ...nextVitals,
  {
    ignores: [
      ".claude/**",
      ".next/**",
      ".supabase-sync-temp/**",
      ".vercel/**",
      "server/**",
      "client/**",
      "docs/**",
      "docs/demo/**",
      "playwright-report/**",
      "samples/**",
      "server/backups/**",
      "server/logs/**",
      "test-results/**"
    ]
  }
];

export default config;
