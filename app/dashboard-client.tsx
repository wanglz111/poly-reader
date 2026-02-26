"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";

import { formatPointTs } from "@/lib/time";
import type { MarketOption, PriceSeriesResponse, TimezoneOption } from "@/types/api";

type SeriesRow = {
  ts: number;
  xLabel: string;
  up_buy_price: number | null;
  chainlink_mid_price: number | null;
};

export default function DashboardClient() {
  const storageKey = "poly-reader.dashboard.v1";
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [tokens, setTokens] = useState<string[]>([]);
  const [token, setToken] = useState<string>("");
  const [timezone, setTimezone] = useState<TimezoneOption>("POLYMARKET");
  const [markets, setMarkets] = useState<MarketOption[]>([]);
  const [marketSlug, setMarketSlug] = useState<string>("");
  const [series, setSeries] = useState<SeriesRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const marketsReqSeq = useRef(0);
  const seriesReqSeq = useRef(0);
  const [chartVersion, setChartVersion] = useState(0);

  useEffect(() => {
    const tokenFromUrl = searchParams.get("token");
    const timezoneFromUrl = searchParams.get("timezone");
    const marketFromUrl = searchParams.get("market_slug");
    if (timezoneFromUrl === "UTC8" || timezoneFromUrl === "POLYMARKET") {
      setTimezone(timezoneFromUrl);
    }
    if (tokenFromUrl && /^[a-z0-9_-]{2,16}$/.test(tokenFromUrl)) {
      setToken(tokenFromUrl);
    }
    if (marketFromUrl && /^[a-z0-9-]{6,160}$/.test(marketFromUrl)) {
      setMarketSlug(marketFromUrl);
    }
    // only initialize from URL once per mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as {
        token?: string;
        timezone?: TimezoneOption;
      };
      if (parsed.timezone === "UTC8" || parsed.timezone === "POLYMARKET") {
        setTimezone(parsed.timezone);
      }
      if (parsed.token && /^[a-z0-9_-]{2,16}$/.test(parsed.token)) {
        setToken(parsed.token);
      }
    } catch {
      // ignore invalid cache
    }
  }, []);

  useEffect(() => {
    const run = async () => {
      try {
        setError("");
        const res = await fetch("/api/tokens", { cache: "no-store" });
        if (!res.ok) {
          throw new Error("加载 token 失败");
        }
        const data = (await res.json()) as string[];
        setTokens(data);
        setToken((prev) => {
          if (data.length === 0) {
            return "";
          }
          if (prev && data.includes(prev)) {
            return prev;
          }
          if (data.includes("btc")) {
            return "btc";
          }
          return data[0];
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : "加载 token 失败";
        setError(message);
      }
    };

    void run();
  }, []);

  useEffect(() => {
    if (!token) {
      return;
    }

    const run = async () => {
      const reqId = ++marketsReqSeq.current;
      try {
        setError("");
        const qs = new URLSearchParams({
          token,
          timezone,
          recent_hours: "72",
          limit: "240"
        });
        const res = await fetch(`/api/markets?${qs.toString()}`, { cache: "no-store" });
        if (!res.ok) {
          throw new Error("加载场次失败");
        }
        const data = (await res.json()) as MarketOption[];
        if (reqId !== marketsReqSeq.current) {
          return;
        }
        setMarkets(data);
        setMarketSlug((prev) => {
          if (prev && data.some((m) => m.market_slug === prev)) {
            return prev;
          }
          try {
            const raw = localStorage.getItem(storageKey);
            if (raw) {
              const parsed = JSON.parse(raw) as { marketSlug?: string };
              if (parsed.marketSlug && data.some((m) => m.market_slug === parsed.marketSlug)) {
                return parsed.marketSlug;
              }
            }
          } catch {
            // ignore
          }
          return data[0]?.market_slug ?? "";
        });
      } catch (e) {
        if (reqId !== marketsReqSeq.current) {
          return;
        }
        const message = e instanceof Error ? e.message : "加载场次失败";
        setError(message);
      }
    };

    void run();
  }, [token, timezone]);

  const selectedMarket = useMemo(
    () => markets.find((item) => item.market_slug === marketSlug),
    [markets, marketSlug]
  );
  const marketOptions = useMemo(() => {
    if (!marketSlug || markets.some((item) => item.market_slug === marketSlug)) {
      return markets;
    }
    return [
      {
        market_slug: marketSlug,
        market_start_ts: 0,
        market_end_ts: 0,
        label: `${marketSlug} (当前已选)`,
        points: 0
      },
      ...markets
    ];
  }, [marketSlug, markets]);
  const timezoneLabel = timezone === "UTC8" ? "UTC+8" : "Polymarket Time (UTC)";
  const tokenMinMax = useMemo(() => {
    const values = series
      .map((item) => item.chainlink_mid_price)
      .filter((v): v is number => v !== null && Number.isFinite(v));
    if (values.length === 0) {
      return null;
    }
    return {
      min: Math.min(...values),
      max: Math.max(...values)
    };
  }, [series]);
  const tokenBasePrice = useMemo(() => {
    const first = series.find((item) => item.chainlink_mid_price !== null);
    return first?.chainlink_mid_price ?? null;
  }, [series]);

  useEffect(() => {
    if (!token) {
      return;
    }
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        token,
        timezone,
        marketSlug
      })
    );
  }, [token, timezone, marketSlug]);

  const loadSeries = async () => {
    if (!token || !marketSlug) {
      return;
    }

    const reqId = ++seriesReqSeq.current;
    try {
      setLoading(true);
      setError("");
      setSeries([]);
      const selected = markets.find((item) => item.market_slug === marketSlug);
      if (!selected) {
        return;
      }
      const qs = new URLSearchParams({ token, timezone });
      qs.set("market_start_ts", String(selected.market_start_ts));
      qs.set("market_end_ts", String(selected.market_end_ts));
      qs.set("market_slug", marketSlug);
      const res = await fetch(`/api/price-series?${qs.toString()}`, {
        cache: "no-store"
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? "查询失败");
      }
      const data = (await res.json()) as PriceSeriesResponse;
      if (reqId !== seriesReqSeq.current) {
        return;
      }
      const rows: SeriesRow[] = data.series.map((point) => ({
        ts: point.ts,
        xLabel: formatPointTs(point.ts, timezone),
        up_buy_price: point.up_buy_price,
        chainlink_mid_price: point.chainlink_mid_price
      }));
      setSeries(rows);
      setChartVersion((v) => v + 1);
    } catch (e) {
      if (reqId !== seriesReqSeq.current) {
        return;
      }
      const message = e instanceof Error ? e.message : "查询失败";
      setError(message);
    } finally {
      if (reqId === seriesReqSeq.current) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    if (!marketSlug || !token) {
      return;
    }
    if (!selectedMarket) {
      return;
    }
    void loadSeries();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketSlug, token, timezone, selectedMarket]);

  useEffect(() => {
    const qs = new URLSearchParams(searchParams.toString());
    if (token) {
      qs.set("token", token);
    }
    qs.set("timezone", timezone);
    if (marketSlug && selectedMarket) {
      qs.set("market_slug", marketSlug);
    } else {
      qs.delete("market_slug");
    }
    const current = searchParams.toString();
    const next = qs.toString();
    if (current !== next) {
      router.replace(`${pathname}?${next}`, { scroll: false });
    }
  }, [marketSlug, pathname, router, searchParams, timezone, token]);

  return (
    <main className="page">
      <div className="panel">
        <h1>Polymarket 5m 走势分析</h1>
        <p>同场次查看 bet price 与 chainlink mid price。</p>

        <div className="filters">
          <label>
            Token
            <select value={token} onChange={(e) => setToken(e.target.value)}>
              {tokens.map((item) => (
                <option key={item} value={item}>
                  {item.toUpperCase()}
                </option>
              ))}
            </select>
          </label>

          <label>
            Timezone
            <select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value as TimezoneOption)}
            >
              <option value="POLYMARKET">Polymarket Time</option>
              <option value="UTC8">UTC+8</option>
            </select>
          </label>

          <label>
            场次
            <select value={marketSlug} onChange={(e) => setMarketSlug(e.target.value)}>
              {marketOptions.map((item) => (
                <option key={item.market_slug} value={item.market_slug}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>

          <button onClick={loadSeries} disabled={loading || !marketSlug || !token}>
            {loading ? "查询中..." : "查询"}
          </button>
        </div>

        <div className="meta" suppressHydrationWarning>
          <span>Timezone: {timezoneLabel}</span>
          <span>样本点: {series.length}</span>
          {selectedMarket ? <span>Slug: {selectedMarket.market_slug}</span> : null}
          {tokenMinMax ? (
            <span>
              Token range: {tokenMinMax.min.toLocaleString(undefined, { maximumFractionDigits: 6 })} ~{" "}
              {tokenMinMax.max.toLocaleString(undefined, { maximumFractionDigits: 6 })}
            </span>
          ) : null}
        </div>

        {error ? <p className="error">{error}</p> : null}

        <div className="chart-wrap">
          {series.length === 0 ? (
            <div className="empty">当前场次暂无数据</div>
          ) : (
            <ResponsiveContainer
              key={`${token}-${timezone}-${marketSlug}-${chartVersion}`}
              width="100%"
              height={460}
            >
              <LineChart
                key={`${token}-${timezone}-${marketSlug}-${chartVersion}`}
                data={series}
                margin={{ top: 10, right: 30, left: 20, bottom: 20 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#D9DED8" />
                <XAxis dataKey="xLabel" minTickGap={80} />
                <YAxis
                  yAxisId="left"
                  domain={[0, 1]}
                  tickFormatter={(v) => Number(v).toFixed(2)}
                  label={{ value: "Polymarket up_buy", angle: -90, position: "insideLeft" }}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  domain={["auto", "auto"]}
                  tickFormatter={(v) =>
                    Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })
                  }
                  label={{ value: "Chainlink mid", angle: 90, position: "insideRight" }}
                />
                {tokenBasePrice !== null && tokenMinMax ? (
                  <>
                    <ReferenceArea
                      yAxisId="right"
                      y1={tokenBasePrice}
                      y2={tokenMinMax.max}
                      fill="#0C5F43"
                      fillOpacity={0.08}
                    />
                    <ReferenceArea
                      yAxisId="right"
                      y1={tokenMinMax.min}
                      y2={tokenBasePrice}
                      fill="#B42318"
                      fillOpacity={0.08}
                    />
                    <ReferenceLine
                      yAxisId="right"
                      y={tokenBasePrice}
                      stroke="#556B5D"
                      strokeDasharray="6 4"
                      strokeWidth={1.5}
                      label={{
                        value: `base ${tokenBasePrice.toLocaleString(undefined, {
                          maximumFractionDigits: 2
                        })}`,
                        position: "insideTopRight",
                        fill: "#556B5D",
                        fontSize: 12
                      }}
                    />
                  </>
                ) : null}
                <Tooltip
                  formatter={(value, name) => {
                    const numericValue =
                      typeof value === "number" ? value : Number(value);
                    if (!Number.isFinite(numericValue)) {
                      return ["null", name];
                    }
                    if (name === "up_buy_price") {
                      return [numericValue.toFixed(4), "up_buy_price"];
                    }
                    return [
                      `${numericValue.toLocaleString(undefined, { maximumFractionDigits: 6 })}`,
                      "chainlink_mid_price"
                    ];
                  }}
                />
                <Legend />
                <Line
                  yAxisId="left"
                  type="linear"
                  dataKey="up_buy_price"
                  name="up_buy_price"
                  stroke="#B44A12"
                  dot={false}
                  strokeWidth={2}
                  isAnimationActive={false}
                  connectNulls
                />
                <Line
                  yAxisId="right"
                  type="linear"
                  dataKey="chainlink_mid_price"
                  name="chainlink_mid_price"
                  stroke="#0C5F43"
                  dot={false}
                  strokeWidth={2}
                  isAnimationActive={false}
                  connectNulls
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </main>
  );
}
