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

import { formatDateKey, formatHourLabel, formatPointTs, formatRangeLabel } from "@/lib/time";
import type { HourBucket, MarketOption, PriceSeriesResponse, TimezoneOption } from "@/types/api";

type SeriesRow = {
  ts: number;
  xLabel: string;
  up_buy_price: number | null;
  chainlink_mid_price: number | null;
};

function isSameHourBuckets(a: HourBucket[], b: HourBucket[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (
      a[i].hour_start_ts !== b[i].hour_start_ts ||
      a[i].hour_end_ts !== b[i].hour_end_ts ||
      a[i].points !== b[i].points
    ) {
      return false;
    }
  }
  return true;
}

function isSameMarketOptions(a: MarketOption[], b: MarketOption[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (
      a[i].market_slug !== b[i].market_slug ||
      a[i].market_start_ts !== b[i].market_start_ts ||
      a[i].market_end_ts !== b[i].market_end_ts ||
      a[i].points !== b[i].points
    ) {
      return false;
    }
  }
  return true;
}

export default function DashboardClient() {
  const storageKey = "poly-reader.dashboard.v1";
  const refreshMs = 15000;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [tokens, setTokens] = useState<string[]>([]);
  const [token, setToken] = useState<string>("");
  const [timezone, setTimezone] = useState<TimezoneOption>("POLYMARKET");
  const [hourBuckets, setHourBuckets] = useState<HourBucket[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [selectedHourStartTs, setSelectedHourStartTs] = useState<number | null>(null);
  const [marketOptions, setMarketOptions] = useState<MarketOption[]>([]);
  const [selectedMarketSlug, setSelectedMarketSlug] = useState<string>("");
  const [series, setSeries] = useState<SeriesRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const marketsReqSeq = useRef(0);
  const marketOptionsReqSeq = useRef(0);
  const seriesReqSeq = useRef(0);
  const lastLatestMarketSlugRef = useRef("");
  const [chartVersion, setChartVersion] = useState(0);

  useEffect(() => {
    const tokenFromUrl = searchParams.get("token");
    const timezoneFromUrl = searchParams.get("timezone");
    const dateFromUrl = searchParams.get("date");
    const hourStartFromUrl = searchParams.get("hour_start_ts");
    const marketSlugFromUrl = searchParams.get("market_slug");
    if (timezoneFromUrl === "UTC8" || timezoneFromUrl === "POLYMARKET") {
      setTimezone(timezoneFromUrl);
    }
    if (tokenFromUrl && /^[a-z0-9_-]{2,16}$/.test(tokenFromUrl)) {
      setToken(tokenFromUrl);
    }
    if (dateFromUrl && /^\d{4}-\d{2}-\d{2}$/.test(dateFromUrl)) {
      setSelectedDate(dateFromUrl);
    }
    if (hourStartFromUrl) {
      const parsed = Number(hourStartFromUrl);
      if (Number.isInteger(parsed) && parsed > 0) {
        setSelectedHourStartTs(parsed);
      }
    }
    if (marketSlugFromUrl && /^[a-z0-9-]{6,160}$/.test(marketSlugFromUrl)) {
      setSelectedMarketSlug(marketSlugFromUrl);
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
        selectedDate?: string;
        selectedHourStartTs?: number;
        selectedMarketSlug?: string;
      };
      if (parsed.timezone === "UTC8" || parsed.timezone === "POLYMARKET") {
        setTimezone(parsed.timezone);
      }
      if (parsed.token && /^[a-z0-9_-]{2,16}$/.test(parsed.token)) {
        setToken(parsed.token);
      }
      if (parsed.selectedDate && /^\d{4}-\d{2}-\d{2}$/.test(parsed.selectedDate)) {
        setSelectedDate(parsed.selectedDate);
      }
      if (
        Number.isInteger(parsed.selectedHourStartTs) &&
        Number(parsed.selectedHourStartTs) > 0
      ) {
        setSelectedHourStartTs(Number(parsed.selectedHourStartTs));
      }
      if (parsed.selectedMarketSlug && /^[a-z0-9-]{6,160}$/.test(parsed.selectedMarketSlug)) {
        setSelectedMarketSlug(parsed.selectedMarketSlug);
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
          recent_hours: String(24 * 30),
          limit: String(24 * 60)
        });
        const res = await fetch(`/api/markets?${qs.toString()}`, { cache: "no-store" });
        if (!res.ok) {
          throw new Error("加载日期小时失败");
        }
        const data = (await res.json()) as HourBucket[];
        if (reqId !== marketsReqSeq.current) {
          return;
        }
        setHourBuckets((prev) => (isSameHourBuckets(prev, data) ? prev : data));
      } catch (e) {
        if (reqId !== marketsReqSeq.current) {
          return;
        }
        const message = e instanceof Error ? e.message : "加载日期小时失败";
        setError(message);
      }
    };

    void run();
    const timer = setInterval(() => {
      void run();
    }, refreshMs);
    return () => clearInterval(timer);
  }, [token, refreshMs]);

  const dateOptions = useMemo(() => {
    const seen = new Set<string>();
    const dates: string[] = [];
    for (const bucket of hourBuckets) {
      const key = formatDateKey(bucket.hour_start_ts, timezone);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      dates.push(key);
    }
    return dates;
  }, [hourBuckets, timezone]);

  const hourOptions = useMemo(
    () =>
      hourBuckets.filter(
        (bucket) => formatDateKey(bucket.hour_start_ts, timezone) === selectedDate
      ),
    [hourBuckets, selectedDate, timezone]
  );
  const selectedHourBucket = useMemo(
    () => hourOptions.find((bucket) => bucket.hour_start_ts === selectedHourStartTs) ?? null,
    [hourOptions, selectedHourStartTs]
  );
  const selectedMarket = useMemo(
    () => marketOptions.find((item) => item.market_slug === selectedMarketSlug) ?? null,
    [marketOptions, selectedMarketSlug]
  );

  useEffect(() => {
    if (dateOptions.length === 0) {
      setSelectedDate("");
      return;
    }
    if (!selectedDate || !dateOptions.includes(selectedDate)) {
      setSelectedDate(dateOptions[0]);
    }
  }, [dateOptions, selectedDate]);

  useEffect(() => {
    if (!selectedDate) {
      setSelectedHourStartTs(null);
      return;
    }
    if (hourOptions.length === 0) {
      setSelectedHourStartTs(null);
      return;
    }
    if (
      selectedHourStartTs !== null &&
      hourOptions.some((bucket) => bucket.hour_start_ts === selectedHourStartTs)
    ) {
      return;
    }
    setSelectedHourStartTs(hourOptions[0].hour_start_ts);
  }, [hourOptions, selectedDate, selectedHourStartTs]);

  useEffect(() => {
    if (!token || selectedHourStartTs === null) {
      setMarketOptions([]);
      setSelectedMarketSlug("");
      return;
    }

    const run = async () => {
      const reqId = ++marketOptionsReqSeq.current;
      try {
        setError("");
        const qs = new URLSearchParams({
          token,
          hour_start_ts: String(selectedHourStartTs),
          limit: "80"
        });
        const res = await fetch(`/api/markets?${qs.toString()}`, { cache: "no-store" });
        if (!res.ok) {
          throw new Error("加载场次失败");
        }
        const data = (await res.json()) as MarketOption[];
        if (reqId !== marketOptionsReqSeq.current) {
          return;
        }
        setMarketOptions((prevOptions) =>
          isSameMarketOptions(prevOptions, data) ? prevOptions : data
        );
        setSelectedMarketSlug((prev) => {
          if (data.length === 0) {
            return "";
          }
          const latestHourStartTs = hourBuckets[0]?.hour_start_ts ?? null;
          const latestSlug = data[0].market_slug;
          const exists = prev && data.some((m) => m.market_slug === prev);
          if (!exists) {
            return latestSlug;
          }
          // Only auto-follow when user was already on the latest market.
          if (
            latestHourStartTs !== null &&
            selectedHourStartTs === latestHourStartTs &&
            prev === lastLatestMarketSlugRef.current
          ) {
            return latestSlug;
          }
          if (prev) {
            return prev;
          }
          return latestSlug;
        });
        lastLatestMarketSlugRef.current = data[0].market_slug;
      } catch (e) {
        if (reqId !== marketOptionsReqSeq.current) {
          return;
        }
        setMarketOptions([]);
        setSelectedMarketSlug("");
        const message = e instanceof Error ? e.message : "加载场次失败";
        setError(message);
      }
    };

    void run();
    const timer = setInterval(() => {
      void run();
    }, refreshMs);
    return () => clearInterval(timer);
  }, [token, selectedHourStartTs, hourBuckets, refreshMs]);

  const timezoneLabel = timezone === "UTC8" ? "UTC+8" : "Polymarket Time (ET)";
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
        selectedDate,
        selectedHourStartTs,
        selectedMarketSlug
      })
    );
  }, [token, timezone, selectedDate, selectedHourStartTs, selectedMarketSlug]);

  const loadSeries = async () => {
    if (!token || !selectedMarket) {
      return;
    }

    const reqId = ++seriesReqSeq.current;
    try {
      setLoading(true);
      setError("");
      const qs = new URLSearchParams({ token, timezone });
      qs.set("market_slug", selectedMarket.market_slug);
      qs.set("market_start_ts", String(selectedMarket.market_start_ts));
      qs.set("market_end_ts", String(selectedMarket.market_end_ts));
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
    if (!selectedMarket || !token) {
      return;
    }
    void loadSeries();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMarketSlug, token, timezone]);

  useEffect(() => {
    const qs = new URLSearchParams(searchParams.toString());
    if (token) {
      qs.set("token", token);
    }
    qs.set("timezone", timezone);
    if (selectedDate) {
      qs.set("date", selectedDate);
    } else {
      qs.delete("date");
    }
    if (selectedHourStartTs !== null) {
      qs.set("hour_start_ts", String(selectedHourStartTs));
    } else {
      qs.delete("hour_start_ts");
    }
    if (selectedMarketSlug) {
      qs.set("market_slug", selectedMarketSlug);
    } else {
      qs.delete("market_slug");
    }
    const current = searchParams.toString();
    const next = qs.toString();
    if (current !== next) {
      router.replace(`${pathname}?${next}`, { scroll: false });
    }
  }, [pathname, router, searchParams, selectedDate, selectedHourStartTs, selectedMarketSlug, timezone, token]);

  return (
    <main className="page">
      <div className="panel">
        <h1>Polymarket 5m 走势分析</h1>
        <p>同场次查看 bet price 与 chainlink mid price。</p>

        <div className="filters">
          <div className="filter-row filter-row-main">
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
                <option value="POLYMARKET">Polymarket Time (ET)</option>
                <option value="UTC8">UTC+8</option>
              </select>
            </label>
          </div>

          <div className="filter-row filter-row-market">
            <label>
              日期
              <select value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)}>
                {dateOptions.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>

            <label>
              小时
              <select
                value={selectedHourStartTs ?? ""}
                onChange={(e) => setSelectedHourStartTs(Number(e.target.value))}
              >
                {hourOptions.map((item) => (
                  <option key={item.hour_start_ts} value={item.hour_start_ts}>
                    {formatHourLabel(item.hour_start_ts, timezone)}
                  </option>
                ))}
              </select>
            </label>

            <label>
              场次
              <select
                value={selectedMarketSlug}
                onChange={(e) => setSelectedMarketSlug(e.target.value)}
              >
                {marketOptions.map((item) => (
                  <option key={item.market_slug} value={item.market_slug}>
                    {formatRangeLabel(item.market_start_ts, item.market_end_ts, timezone)}
                  </option>
                ))}
              </select>
            </label>

            <button onClick={loadSeries} disabled={loading || !selectedMarket || !token}>
              {loading ? "查询中..." : "查询"}
            </button>
          </div>
        </div>

        <div className="meta" suppressHydrationWarning>
          <span>Timezone: {timezoneLabel}</span>
          <span>样本点: {series.length}</span>
          {selectedDate ? <span>日期: {selectedDate}</span> : null}
          {selectedHourBucket ? (
            <span>小时: {formatHourLabel(selectedHourBucket.hour_start_ts, timezone)}</span>
          ) : null}
          {selectedMarket ? <span>场次: {selectedMarket.market_slug}</span> : null}
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
              key={`${token}-${timezone}-${selectedMarketSlug || "none"}-${chartVersion}`}
              width="100%"
              height={460}
            >
              <LineChart
                key={`${token}-${timezone}-${selectedMarketSlug || "none"}-${chartVersion}`}
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
