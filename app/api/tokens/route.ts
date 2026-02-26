import { NextResponse } from "next/server";

import { listTokens } from "@/lib/db";
import { cacheGetJson, cacheSetJson } from "@/lib/redis-cache";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const cacheKey = "poly-reader:tokens:v1";
    const cached = await cacheGetJson<string[]>(cacheKey);
    if (cached) {
      return NextResponse.json(cached, {
        headers: {
          "Cache-Control": "public, s-maxage=30, stale-while-revalidate=120",
          "X-Cache": "HIT"
        }
      });
    }

    const tokens = await listTokens();
    await cacheSetJson(cacheKey, tokens, 120);
    return NextResponse.json(tokens, {
      headers: {
        "Cache-Control": "public, s-maxage=30, stale-while-revalidate=120",
        "X-Cache": "MISS"
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to load tokens";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
