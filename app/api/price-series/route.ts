import { NextRequest, NextResponse } from "next/server";

import {
  getMarketSlugByWindow,
  getMarketWindow,
  getPriceSeries,
  getPriceSeriesByHour,
  getPriceSeriesByWindow
} from "@/lib/db";
import { cacheGetJson, cacheSetJson } from "@/lib/redis-cache";
import {
  parseUnixTs,
  requireMarketSlug,
  requireToken,
  requireTimezone
} from "@/lib/validate";
import type { PricePoint } from "@/types/api";

export const dynamic = "force-dynamic";

const IMMUTABLE_TTL_SECONDS = 86400 * 90;

type PricePayload = {
  meta: {
    token: string;
    market_slug: string;
    market_start_ts: number;
    market_end_ts: number;
    timezone: string;
  };
  series: PricePoint[];
};

export async function GET(req: NextRequest) {
  try {
    const nowTs = Math.floor(Date.now() / 1000);
    const token = requireToken(req.nextUrl.searchParams.get("token"));
    const timezone = requireTimezone(req.nextUrl.searchParams.get("timezone"));
    const marketSlugInput = req.nextUrl.searchParams.get("market_slug");
    const marketStartTs =
      parseUnixTs(req.nextUrl.searchParams.get("market_start_ts"), "market_start_ts") ??
      parseUnixTs(req.nextUrl.searchParams.get("market_startat"), "market_startat");
    const marketEndTs =
      parseUnixTs(req.nextUrl.searchParams.get("market_end_ts"), "market_end_ts") ??
      parseUnixTs(req.nextUrl.searchParams.get("market_end"), "market_end");
    const hourStartTs = parseUnixTs(
      req.nextUrl.searchParams.get("hour_start_ts"),
      "hour_start_ts"
    );

    let marketSlug = "";
    let marketWindow: { market_start_ts: number; market_end_ts: number } | null = null;
    let series: PricePoint[] = [];
    const cacheDiscriminator = hourStartTs !== null
      ? `hour:${hourStartTs}`
      : marketSlugInput
        ? `slug:${marketSlugInput}`
        : marketStartTs !== null && marketEndTs !== null
          ? `window:${marketStartTs}:${marketEndTs}`
          : "invalid";
    const cacheKey = `poly-reader:price-series:v4:${token}:${timezone}:${cacheDiscriminator}`;
    const cached = await cacheGetJson<PricePayload>(cacheKey);
    if (cached) {
      return NextResponse.json(cached, {
        headers: {
          "X-Cache": "HIT",
          "X-Cache-TTL": String(IMMUTABLE_TTL_SECONDS)
        }
      });
    }

    if (hourStartTs !== null) {
      const hourEndTs = hourStartTs + 3600;
      if (hourEndTs > nowTs) {
        return NextResponse.json({ error: "hour is not closed yet" }, { status: 400 });
      }
      series = await getPriceSeriesByHour(token, hourStartTs);
      marketWindow = { market_start_ts: hourStartTs, market_end_ts: hourEndTs };
      marketSlug = `${token}-hour-${hourStartTs}`;
    } else if (marketSlugInput) {
      marketSlug = requireMarketSlug(marketSlugInput);
      [series, marketWindow] = await Promise.all([
        getPriceSeries(token, marketSlug),
        getMarketWindow(token, marketSlug)
      ]);
    } else {
      if (marketStartTs === null || marketEndTs === null) {
        return NextResponse.json(
          { error: "hour_start_ts or market_slug or (market_startat + market_end) is required" },
          { status: 400 }
        );
      }
      if (marketStartTs >= marketEndTs) {
        return NextResponse.json(
          { error: "market_startat must be smaller than market_end" },
          { status: 400 }
        );
      }
      if (marketEndTs > nowTs) {
        return NextResponse.json(
          { error: "market is not closed yet" },
          { status: 400 }
        );
      }
      const [seriesResult, marketSlugMaybe] = await Promise.all([
        getPriceSeriesByWindow(token, marketStartTs, marketEndTs),
        getMarketSlugByWindow(token, marketStartTs, marketEndTs)
      ]);
      series = seriesResult;
      marketWindow = { market_start_ts: marketStartTs, market_end_ts: marketEndTs };
      if (!marketSlugMaybe) {
        return NextResponse.json({ error: "market not found" }, { status: 404 });
      }
      marketSlug = marketSlugMaybe;
    }

    if (!marketWindow) {
      return NextResponse.json({ error: "market not found" }, { status: 404 });
    }
    if (marketWindow.market_end_ts > nowTs) {
      return NextResponse.json({ error: "market is not closed yet" }, { status: 400 });
    }

    const payload: PricePayload = {
      meta: {
        token,
        market_slug: marketSlug,
        market_start_ts: marketWindow.market_start_ts,
        market_end_ts: marketWindow.market_end_ts,
        timezone
      },
      series
    };

    const aliasKeys = new Set<string>([
      cacheKey,
      `poly-reader:price-series:v4:${token}:${timezone}:slug:${marketSlug}`,
      `poly-reader:price-series:v4:${token}:${timezone}:window:${marketWindow.market_start_ts}:${marketWindow.market_end_ts}`
    ]);
    if (marketWindow.market_end_ts - marketWindow.market_start_ts === 3600) {
      aliasKeys.add(`poly-reader:price-series:v4:${token}:${timezone}:hour:${marketWindow.market_start_ts}`);
    }

    await Promise.all(Array.from(aliasKeys, (key) => cacheSetJson(key, payload, IMMUTABLE_TTL_SECONDS)));
    return NextResponse.json(payload, {
      headers: {
        "X-Cache": "MISS",
        "X-Cache-TTL": String(IMMUTABLE_TTL_SECONDS),
        "X-Cache-Keys-Written": String(aliasKeys.size)
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to load price series";
    const status = message.startsWith("invalid") || message.includes("required") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
