import nextVitals from "eslint-config-next/core-web-vitals";

/** @type {import("eslint").Linter.Config[]} */
const config = [
  ...nextVitals,
  {
    ignores: [
      "server/**",
      "client/**",
      "docs/demo/**",
      "server/backups/**",
      "server/logs/**"
    ]
  }
];

export default config;
