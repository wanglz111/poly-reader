import { NextRequest, NextResponse } from "next/server";

import { runCacheSyncBatch } from "@/lib/cache-sync";

export const dynamic = "force-dynamic";

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CACHE_SYNC_SECRET?.trim();
  if (!secret) {
    return true;
  }
  const auth = req.headers.get("authorization") ?? "";
  if (auth === `Bearer ${secret}`) {
    return true;
  }
  return req.nextUrl.searchParams.get("secret") === secret;
}

async function syncAll(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const batchSizeRaw = Number(req.nextUrl.searchParams.get("batch") ?? "200");
  const result = await runCacheSyncBatch(batchSizeRaw);
  return NextResponse.json(result);
}

export async function GET(req: NextRequest) {
  return syncAll(req);
}

export async function POST(req: NextRequest) {
  return syncAll(req);
}
