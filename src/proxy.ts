import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { SESSION_COOKIE_NAME, getSession } from "@/lib/auth/session";

const AUTH_ROUTES = ["/login", "/register"];

function trimTrailingSlash(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

function isProtectedRoute(pathname: string): boolean {
  return pathname === "/notes" || pathname.startsWith("/notes/");
}

function isAuthRoute(pathname: string): boolean {
  return AUTH_ROUTES.includes(pathname);
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const normalizedPathname = trimTrailingSlash(pathname);

  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await getSession(token) : null;
  const isAuthenticated = session !== null;

  if (isProtectedRoute(normalizedPathname) && !isAuthenticated) {
    return NextResponse.redirect(new URL("/login", request.nextUrl));
  }

  if (
    isAuthenticated &&
    (normalizedPathname === "/" || isAuthRoute(normalizedPathname))
  ) {
    return NextResponse.redirect(new URL("/notes", request.nextUrl));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/notes/:path*", "/login", "/register", "/"],
};