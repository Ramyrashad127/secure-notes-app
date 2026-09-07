import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Simple unauthenticated liveness probe used by the Docker healthcheck.
 * No sensitive information is exposed.
 */
export async function GET() {
  return NextResponse.json({ status: "ok" });
}