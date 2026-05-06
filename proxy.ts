import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const E2E_PUBLIC_PREFIXES = ["/login", "/auth", "/_next", "/api", "/favicon", "/public"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // In E2E smoke tests (NEXT_PUBLIC_DISABLE_SUPABASE=true), redirect protected
  // routes to /login server-side — avoids relying on client-side Supabase getUser.
  // Not active in real-app mode (E2E_REAL_APP=true) where tests authenticate normally.
  if (
    request.headers.get("x-playwright-e2e") === "1" &&
    process.env.NEXT_PUBLIC_DISABLE_SUPABASE === "true"
  ) {
    const isPublic =
      E2E_PUBLIC_PREFIXES.some((p) => pathname.startsWith(p)) ||
      pathname === "/" ||
      pathname.includes(".");
    if (!isPublic) {
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      url.searchParams.set("redirect", pathname);
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/api") ||
    pathname.includes(".") ||
    pathname === "/" ||
    pathname === "/login"
  ) {
    return NextResponse.next();
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!favicon.ico).*)"]
};
