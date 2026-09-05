import { NextResponse } from "next/server";
import {
  metricsAccessToken,
  registry,
  safeTokenEqual,
} from "@/lib/metrics";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function unauthorized(): NextResponse {
  return new NextResponse("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": "Bearer",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

export async function GET(request: Request) {
  const authorization = request.headers.get("authorization");
  const expectedToken = metricsAccessToken();

  if (!expectedToken || !authorization) {
    return unauthorized();
  }

  const [scheme, token] = authorization.split(" ");
  if (
    scheme?.toLowerCase() !== "bearer" ||
    !token ||
    !safeTokenEqual(token, expectedToken)
  ) {
    return unauthorized();
  }

  const metrics = await registry.metrics();

  return new NextResponse(metrics, {
    headers: {
      "Content-Type": registry.contentType,
    },
  });
}