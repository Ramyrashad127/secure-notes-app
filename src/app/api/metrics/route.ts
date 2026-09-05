import { NextResponse } from "next/server";
import { registry } from "@/lib/metrics";

export const dynamic = "force-dynamic";

export async function GET() {
  const metrics = await registry.metrics();

  return new NextResponse(metrics, {
    headers: {
      "Content-Type": registry.contentType,
    },
  });
}
