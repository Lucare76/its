import { NextRequest } from "next/server";
import { buildServicesExportXlsx } from "@/lib/server/services-export";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  return buildServicesExportXlsx(request);
}

export async function POST(request: NextRequest) {
  return buildServicesExportXlsx(request);
}
