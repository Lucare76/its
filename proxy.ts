import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isAllowed, parseRole, ROLE_COOKIE } from "@/lib/rbac";

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/api") ||
    pathname.includes(".") ||
    pathname === "/" ||
    pathname === "/login"
  ) {
    return NextResponse.next();
  }

  const role = parseRole(request.cookies.get(ROLE_COOKIE)?.value);
  if (!isAllowed(pathname, role)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("redirect", pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!favicon.ico).*)"]
};
