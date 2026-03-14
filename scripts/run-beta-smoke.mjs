import { spawnSync } from "node:child_process";

const steps = [
  ["node", ["scripts/test-agency-area-flow.mjs"]],
  ["node", ["scripts/test-pdf-parser-selection.mjs"]],
  ["node", ["scripts/test-pdf-review-flow.mjs", "samples/review-test.pdf"]],
  ["node", ["scripts/test-dashboard-dispatch-pdf-meta.mjs"]]
];

for (const [cmd, args] of steps) {
  const result = spawnSync(cmd, args, { stdio: "inherit", shell: false });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log("beta smoke complete");
