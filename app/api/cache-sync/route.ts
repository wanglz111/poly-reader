import { NextRequest, NextResponse } from "next/server";

import {
  getPriceSeriesByWindow,
  listClosedMarketsAfter,
  listMarketsByHour,
  listTokens
} from "@/lib/db";
import { cacheGetJson, cacheSetJson } from "@/lib/redis-cache";
import type { TimezoneOption } from "@/types/api";

export const dynamic = "force-dynamic";

const PRICE_TTL_SECONDS = 86400 * 90;
const MARKETS_TTL_SECONDS = 86400 * 30;
const TOKENS_TTL_SECONDS = 3600;
const STATE_TTL_SECONDS = 86400 * 365;
const STATE_KEY = "poly-reader:sync:v1:state";

type SyncState = {
  cursor: {
    market_end_ts: number;
    token: string;
    market_slug: string;
  };
  updated_at: number;
};

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

function buildPriceAliasKeys(
  token: string,
  timezone: TimezoneOption,
  marketSlug: string,
  marketStartTs: number,
  marketEndTs: number
): string[] {
  const keys = [
    `poly-reader:price-series:v4:${token}:${timezone}:slug:${marketSlug}`,
    `poly-reader:price-series:v4:${token}:${timezone}:window:${marketStartTs}:${marketEndTs}`
  ];
  if (marketEndTs - marketStartTs === 3600) {
    keys.push(`poly-reader:price-series:v4:${token}:${timezone}:hour:${marketStartTs}`);
  }
  return keys;
}

async function syncAll(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const batchSizeRaw = Number(req.nextUrl.searchParams.get("batch") ?? "200");
  const batchSize = Number.isFinite(batchSizeRaw) ? Math.max(20, Math.min(1000, Math.floor(batchSizeRaw))) : 200;

  const state = (await cacheGetJson<SyncState>(STATE_KEY)) ?? {
    cursor: { market_end_ts: 0, token: "", market_slug: "" },
    updated_at: 0
  };

  const refs = await listClosedMarketsAfter(state.cursor, batchSize);
  if (refs.length === 0) {
    return NextResponse.json({
      ok: true,
      processed_markets: 0,
      warmed_hours: 0,
      cursor: state.cursor
    });
  }

  const touchedHours = new Set<string>();
  let writtenPriceKeys = 0;
  let nextCursor = { ...state.cursor };

  for (const ref of refs) {
    const series = await getPriceSeriesByWindow(ref.token, ref.market_start_ts, ref.market_end_ts);
    if (series.length === 0) {
      continue;
    }

    const hourStartTs = Math.floor(ref.market_start_ts / 3600) * 3600;
    touchedHours.add(`${ref.token}:${hourStartTs}`);

    const timezones: TimezoneOption[] = ["POLYMARKET", "UTC8"];
    for (const timezone of timezones) {
      const payload = {
        meta: {
          token: ref.token,
          market_slug: ref.market_slug,
          market_start_ts: ref.market_start_ts,
          market_end_ts: ref.market_end_ts,
          timezone
        },
        series
      };
      const keys = buildPriceAliasKeys(
        ref.token,
        timezone,
        ref.market_slug,
        ref.market_start_ts,
        ref.market_end_ts
      );
      await Promise.all(keys.map((key) => cacheSetJson(key, payload, PRICE_TTL_SECONDS)));
      writtenPriceKeys += keys.length;
    }

    nextCursor = {
      market_end_ts: ref.market_end_ts,
      token: ref.token,
      market_slug: ref.market_slug
    };
  }

  for (const tokenHour of touchedHours) {
    const [token, hourStart] = tokenHour.split(":");
    const hourStartTs = Number(hourStart);
    if (!Number.isFinite(hourStartTs)) {
      continue;
    }
    const markets = await listMarketsByHour(token, hourStartTs, 200);
    await cacheSetJson(`poly-reader:markets:v4:hour-full:${token}:${hourStartTs}`, markets, MARKETS_TTL_SECONDS);
  }

  const tokens = await listTokens();
  await cacheSetJson("poly-reader:tokens:v2", tokens, TOKENS_TTL_SECONDS);
  await cacheSetJson(
    STATE_KEY,
    {
      cursor: nextCursor,
      updated_at: Math.floor(Date.now() / 1000)
    },
    STATE_TTL_SECONDS
  );

  return NextResponse.json({
    ok: true,
    processed_markets: refs.length,
    written_price_keys: writtenPriceKeys,
    warmed_hours: touchedHours.size,
    cursor: nextCursor
  });
}

export async function GET(req: NextRequest) {
  return syncAll(req);
}

export async function POST(req: NextRequest) {
  return syncAll(req);
}
