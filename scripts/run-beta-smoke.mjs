import { spawnSync } from "node:child_process";

async function ensureAppReachable() {
  const baseUrl = (process.env.NEXT_PUBLIC_APP_URL || "http://127.0.0.1:3010").replace(/\/$/, "");
  try {
    const response = await fetch(`${baseUrl}/login`, { method: "GET" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new Error(`beta smoke richiede app avviata su ${baseUrl} (${detail})`);
  }
}

const steps = [
  ["node", ["scripts/test-agency-area-flow.mjs"]],
  ["node", ["scripts/test-pdf-parser-selection.mjs"]],
  ["node", ["scripts/test-pdf-review-flow.mjs", "samples/review-test.pdf"]],
  ["node", ["scripts/test-dashboard-dispatch-pdf-meta.mjs"]]
];

async function main() {
  await ensureAppReachable();

  for (const [cmd, args] of steps) {
    const result = spawnSync(cmd, args, { stdio: "inherit", shell: false });
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  }

  console.log("beta smoke complete");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
