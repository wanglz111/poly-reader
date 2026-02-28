import {
  getPriceSeriesByWindow,
  listClosedMarketsAfter,
  listMarketsByHour,
  listTokens
} from "@/lib/db";
import { cacheGetJson, cacheSetJson } from "@/lib/redis-cache";
import type { TimezoneOption } from "@/types/api";

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

type SyncResult = {
  ok: true;
  processed_markets: number;
  written_price_keys: number;
  warmed_hours: number;
  cursor: SyncState["cursor"];
};

declare global {
  // eslint-disable-next-line no-var
  var __polySyncLastKickTs: number | undefined;
  // eslint-disable-next-line no-var
  var __polySyncInFlight: Promise<SyncResult> | undefined;
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

export async function runCacheSyncBatch(batchSize = 200): Promise<SyncResult> {
  const safeBatchSize = Number.isFinite(batchSize)
    ? Math.max(20, Math.min(1000, Math.floor(batchSize)))
    : 200;

  const state = (await cacheGetJson<SyncState>(STATE_KEY)) ?? {
    cursor: { market_end_ts: 0, token: "", market_slug: "" },
    updated_at: 0
  };

  const refs = await listClosedMarketsAfter(state.cursor, safeBatchSize);
  if (refs.length === 0) {
    return {
      ok: true,
      processed_markets: 0,
      written_price_keys: 0,
      warmed_hours: 0,
      cursor: state.cursor
    };
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

  return {
    ok: true,
    processed_markets: refs.length,
    written_price_keys: writtenPriceKeys,
    warmed_hours: touchedHours.size,
    cursor: nextCursor
  };
}

export function triggerCacheSyncBestEffort(): void {
  if (process.env.AUTO_CACHE_SYNC_ON_READ === "false") {
    return;
  }

  const now = Date.now();
  const minIntervalSecRaw = Number(process.env.AUTO_CACHE_SYNC_MIN_INTERVAL_SEC ?? "120");
  const minIntervalMs = Number.isFinite(minIntervalSecRaw) && minIntervalSecRaw > 0
    ? minIntervalSecRaw * 1000
    : 120000;

  if (global.__polySyncLastKickTs && now - global.__polySyncLastKickTs < minIntervalMs) {
    return;
  }

  if (global.__polySyncInFlight) {
    return;
  }

  global.__polySyncLastKickTs = now;
  global.__polySyncInFlight = runCacheSyncBatch(200)
    .catch(() => ({
      ok: true as const,
      processed_markets: 0,
      written_price_keys: 0,
      warmed_hours: 0,
      cursor: { market_end_ts: 0, token: "", market_slug: "" }
    }))
    .finally(() => {
      global.__polySyncInFlight = undefined;
    });
}
