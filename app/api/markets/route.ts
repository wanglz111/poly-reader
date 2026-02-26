import { NextRequest, NextResponse } from "next/server";

import { listHourBuckets, listMarketsByHour } from "@/lib/db";
import { cacheGetJson, cacheSetJson } from "@/lib/redis-cache";
import { parseUnixTs, requireToken } from "@/lib/validate";
import type { HourBucket, MarketOption } from "@/types/api";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const token = requireToken(req.nextUrl.searchParams.get("token"));
    const hourStartTs = parseUnixTs(req.nextUrl.searchParams.get("hour_start_ts"), "hour_start_ts");
    const nowTs = Math.floor(Date.now() / 1000);
    const recentHoursRaw = req.nextUrl.searchParams.get("recent_hours");
    const limitRaw = req.nextUrl.searchParams.get("limit");
    if (hourStartTs !== null) {
      const marketLimit = limitRaw === null ? 40 : Math.max(10, Math.min(200, Number(limitRaw)));
      if (!Number.isFinite(marketLimit)) {
        return NextResponse.json({ error: "invalid limit" }, { status: 400 });
      }
      const hourEndTs = hourStartTs + 3600;
      const isClosedHour = hourEndTs <= nowTs;
      const ttlSeconds = isClosedHour ? 86400 * 14 : 15;
      const cacheKey = `poly-reader:markets:v3:hour:${token}:${hourStartTs}:${marketLimit}`;
      const cached = await cacheGetJson<MarketOption[]>(cacheKey);
      if (cached) {
        return NextResponse.json(cached, {
          headers: {
            "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30",
            "X-Cache": "HIT",
            "X-Cache-TTL": String(ttlSeconds)
          }
        });
      }
      const markets = await listMarketsByHour(token, hourStartTs, marketLimit);
      await cacheSetJson(cacheKey, markets, ttlSeconds);
      return NextResponse.json(markets, {
        headers: {
          "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30",
          "X-Cache": "MISS",
          "X-Cache-TTL": String(ttlSeconds)
        }
      });
    } else {
      const recentHours =
        recentHoursRaw === null ? 24 * 14 : Math.max(24, Math.min(24 * 90, Number(recentHoursRaw)));
      const limit = limitRaw === null ? 24 * 30 : Math.max(24, Math.min(24 * 120, Number(limitRaw)));
      if (!Number.isFinite(recentHours) || !Number.isFinite(limit)) {
        return NextResponse.json({ error: "invalid recent_hours or limit" }, { status: 400 });
      }

      const cacheKey = `poly-reader:markets:v3:hour-buckets:${token}:${recentHours}:${limit}`;
      const cached = await cacheGetJson<HourBucket[]>(cacheKey);
      if (cached) {
        return NextResponse.json(cached, {
          headers: {
            "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30",
            "X-Cache": "HIT"
          }
        });
      }

      const hourBuckets = await listHourBuckets(token, recentHours, limit);
      await cacheSetJson(cacheKey, hourBuckets, 15);
      return NextResponse.json(hourBuckets, {
        headers: {
          "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30",
          "X-Cache": "MISS"
        }
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to load markets";
    const status = message.startsWith("invalid") || message.includes("required") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
