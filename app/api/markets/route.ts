import { NextRequest, NextResponse } from "next/server";

import { listMarkets } from "@/lib/db";
import { formatRangeLabel } from "@/lib/time";
import { requireToken, requireTimezone } from "@/lib/validate";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const token = requireToken(req.nextUrl.searchParams.get("token"));
    const timezone = requireTimezone(req.nextUrl.searchParams.get("timezone"));
    const recentHoursRaw = req.nextUrl.searchParams.get("recent_hours");
    const limitRaw = req.nextUrl.searchParams.get("limit");
    const onlyClosedRaw = req.nextUrl.searchParams.get("only_closed");
    const recentHours =
      recentHoursRaw === null ? 12 : Math.max(1, Math.min(168, Number(recentHoursRaw)));
    const limit = limitRaw === null ? 200 : Math.max(20, Math.min(500, Number(limitRaw)));
    const onlyClosed = onlyClosedRaw === null ? true : onlyClosedRaw !== "false";
    if (!Number.isFinite(recentHours) || !Number.isFinite(limit)) {
      return NextResponse.json({ error: "invalid recent_hours or limit" }, { status: 400 });
    }

    const markets = await listMarkets(token, recentHours, limit, onlyClosed);
    const withLabel = markets.map((market) => ({
      ...market,
      label: formatRangeLabel(market.market_start_ts, market.market_end_ts, timezone)
    }));

    return NextResponse.json(withLabel, {
      headers: {
        "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30"
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to load markets";
    const status = message.startsWith("invalid") || message.includes("required") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
