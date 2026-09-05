import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE_NAME, getSession } from "@/lib/auth/session";
import { normalizeHttpRoute, recordHttpRequest } from "@/lib/metrics";

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
  const startedAt = performance.now();
  const { pathname } = request.nextUrl;
  const normalizedPathname = trimTrailingSlash(pathname);

  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await getSession(token) : null;
  const isAuthenticated = session !== null;

  let response: NextResponse;
  if (isProtectedRoute(normalizedPathname) && !isAuthenticated) {
    response = NextResponse.redirect(new URL("/login", request.nextUrl));
  } else if (
    isAuthenticated &&
    (normalizedPathname === "/" || isAuthRoute(normalizedPathname))
  ) {
    response = NextResponse.redirect(new URL("/notes", request.nextUrl));
  } else {
    response = NextResponse.next();
  }

  recordHttpRequest({
    method: request.method,
    route: normalizeHttpRoute(normalizedPathname),
    status: response.status,
    durationSeconds: (performance.now() - startedAt) / 1000,
  });

  return response;
}

export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:png|jpe?g|gif|svg|webp|ico|css|js|woff2?|ttf|otf)$).*)",
  ],
};