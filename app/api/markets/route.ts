import { NextRequest, NextResponse } from "next/server";

import { listHourBuckets, listMarketsByHour } from "@/lib/db";
import { triggerCacheSyncBestEffort } from "@/lib/cache-sync";
import { cacheGetJson, cacheSetJson } from "@/lib/redis-cache";
import { parseUnixTs, requireToken } from "@/lib/validate";
import type { HourBucket, MarketOption } from "@/types/api";

export const dynamic = "force-dynamic";

const IMMUTABLE_TTL_SECONDS = 86400 * 30;

export async function GET(req: NextRequest) {
  try {
    triggerCacheSyncBestEffort();
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
      const fullCacheKey = `poly-reader:markets:v4:hour-full:${token}:${hourStartTs}`;
      const responseCacheKey = `poly-reader:markets:v4:hour:${token}:${hourStartTs}:${marketLimit}`;
      const ttlSeconds = isClosedHour ? IMMUTABLE_TTL_SECONDS : 15;

      if (isClosedHour) {
        const cachedFull = await cacheGetJson<MarketOption[]>(fullCacheKey);
        if (cachedFull) {
          return NextResponse.json(cachedFull.slice(0, marketLimit), {
            headers: {
              "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30",
              "X-Cache": "HIT",
              "X-Cache-Key": "hour-full",
              "X-Cache-TTL": String(ttlSeconds)
            }
          });
        }
      }

      const cached = await cacheGetJson<MarketOption[]>(responseCacheKey);
      if (cached) {
        return NextResponse.json(cached, {
          headers: {
            "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30",
            "X-Cache": "HIT",
            "X-Cache-Key": "hour-limit",
            "X-Cache-TTL": String(ttlSeconds)
          }
        });
      }

      const queryLimit = isClosedHour ? 200 : marketLimit;
      const markets = await listMarketsByHour(token, hourStartTs, queryLimit);
      if (isClosedHour) {
        await cacheSetJson(fullCacheKey, markets, ttlSeconds);
      }

      const responsePayload = markets.slice(0, marketLimit);
      await cacheSetJson(responseCacheKey, responsePayload, ttlSeconds);
      return NextResponse.json(responsePayload, {
        headers: {
          "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30",
          "X-Cache": "MISS",
          "X-Cache-Key": isClosedHour ? "hour-full" : "hour-limit",
          "X-Cache-TTL": String(ttlSeconds)
        }
      });
    }

    const recentHours =
      recentHoursRaw === null ? 24 * 14 : Math.max(24, Math.min(24 * 90, Number(recentHoursRaw)));
    const limit = limitRaw === null ? 24 * 30 : Math.max(24, Math.min(24 * 120, Number(limitRaw)));
    if (!Number.isFinite(recentHours) || !Number.isFinite(limit)) {
      return NextResponse.json({ error: "invalid recent_hours or limit" }, { status: 400 });
    }

    const fullCacheKey = `poly-reader:markets:v4:hour-buckets-full:${token}:${recentHours}`;
    const responseCacheKey = `poly-reader:markets:v4:hour-buckets:${token}:${recentHours}:${limit}`;

    const cachedFull = await cacheGetJson<HourBucket[]>(fullCacheKey);
    if (cachedFull) {
      return NextResponse.json(cachedFull.slice(0, limit), {
        headers: {
          "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30",
          "X-Cache": "HIT",
          "X-Cache-Key": "hour-buckets-full",
          "X-Cache-TTL": "30"
        }
      });
    }

    const cached = await cacheGetJson<HourBucket[]>(responseCacheKey);
    if (cached) {
      return NextResponse.json(cached, {
        headers: {
          "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30",
          "X-Cache": "HIT",
          "X-Cache-Key": "hour-buckets-limit",
          "X-Cache-TTL": "30"
        }
      });
    }

    const queryLimit = 24 * 120;
    const hourBuckets = await listHourBuckets(token, recentHours, queryLimit);
    await cacheSetJson(fullCacheKey, hourBuckets, 30);
    const responsePayload = hourBuckets.slice(0, limit);
    await cacheSetJson(responseCacheKey, responsePayload, 30);

    return NextResponse.json(responsePayload, {
      headers: {
        "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30",
        "X-Cache": "MISS",
        "X-Cache-Key": "hour-buckets-full",
        "X-Cache-TTL": "30"
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to load markets";
    const status = message.startsWith("invalid") || message.includes("required") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
