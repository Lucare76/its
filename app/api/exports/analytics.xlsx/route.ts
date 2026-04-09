import { NextRequest } from "next/server";
import { buildAnalyticsExportXlsxResponse } from "@/lib/server/analytics";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  return buildAnalyticsExportXlsxResponse(request);
}
