import { NextRequest } from "next/server";
import { buildAnalyticsSummaryResponse } from "@/lib/server/analytics";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  return buildAnalyticsSummaryResponse(request);
}
