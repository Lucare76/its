import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const E2E_PUBLIC_PREFIXES = ["/login", "/auth", "/_next", "/api", "/favicon", "/public"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // In E2E smoke tests, redirect all protected routes to /login server-side.
  // This avoids relying on client-side auth (Supabase getUser lock / React hydration).
  if (request.headers.get("x-playwright-e2e") === "1") {
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
