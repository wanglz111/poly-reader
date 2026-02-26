import { NextResponse } from "next/server";

import { listTokens } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const tokens = await listTokens();
    return NextResponse.json(tokens, {
      headers: {
        "Cache-Control": "public, s-maxage=30, stale-while-revalidate=120"
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to load tokens";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
