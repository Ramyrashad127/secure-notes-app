import { NextResponse } from "next/server";
import * as client from "@prometheus-io/client";
import "@/lib/metrics";

export const dynamic = "force-dynamic";

export async function GET() {
  const metrics = await client.register.metrics();

  return new NextResponse(metrics, {
    headers: {
      "Content-Type": client.contentType,
    },
  });
}