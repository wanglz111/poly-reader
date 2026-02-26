import mysql, { Pool, RowDataPacket } from "mysql2/promise";

import type { MarketOption, PricePoint } from "@/types/api";

const TABLE = "price_snapshots_1s";

declare global {
  // eslint-disable-next-line no-var
  var __polyReaderPool: Pool | undefined;
}

function getConnectionUri(): string | null {
  if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim()) {
    return process.env.DATABASE_URL;
  }

  const host = process.env.MYSQL_HOST;
  const user = process.env.MYSQL_USER;
  const password = process.env.MYSQL_PASSWORD;
  const database = process.env.MYSQL_DATABASE;
  const port = process.env.MYSQL_PORT ?? "3306";

  if (!host || !user || !password || !database) {
    return null;
  }

  return `mysql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}

function getPool(): Pool {
  if (global.__polyReaderPool) {
    return global.__polyReaderPool;
  }

  const uri = getConnectionUri();
  if (!uri) {
    throw new Error("MySQL env is not configured");
  }

  const ssl = process.env.MYSQL_SSL === "true" ? {} : undefined;

  global.__polyReaderPool = mysql.createPool({
    uri,
    waitForConnections: true,
    connectionLimit: 8,
    queueLimit: 0,
    timezone: "Z",
    ssl
  });

  return global.__polyReaderPool;
}

export async function listTokens(): Promise<string[]> {
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT DISTINCT base_symbol FROM ${TABLE} ORDER BY base_symbol`
  );
  return rows.map((row) => String(row.base_symbol));
}

export async function listMarkets(
  token: string,
  recentHours = 12,
  limit = 200,
  onlyClosed = true
): Promise<MarketOption[]> {
  const pool = getPool();
  const nowTs = Math.floor(Date.now() / 1000);
  const closedFilter = onlyClosed ? "AND market_end_ts <= ?" : "";
  const [rows] = await pool.query<RowDataPacket[]>(
    `
      SELECT
        market_slug,
        market_start_ts,
        market_end_ts,
        COUNT(*) AS points
      FROM ${TABLE}
      WHERE base_symbol = ?
        AND captured_at_ts >= (
          SELECT GREATEST(0, MAX(captured_at_ts) - ?)
          FROM ${TABLE}
          WHERE base_symbol = ?
        )
        ${closedFilter}
      GROUP BY market_slug, market_start_ts, market_end_ts
      ORDER BY market_start_ts DESC
      LIMIT ?
    `,
    onlyClosed
      ? [token, recentHours * 3600, token, nowTs, limit]
      : [token, recentHours * 3600, token, limit]
  );

  return rows.map((row) => ({
    market_slug: String(row.market_slug),
    market_start_ts: Number(row.market_start_ts),
    market_end_ts: Number(row.market_end_ts),
    label: "",
    points: Number(row.points)
  }));
}

export async function getPriceSeries(token: string, marketSlug: string): Promise<PricePoint[]> {
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `
      SELECT
        captured_at_ts,
        up_buy_price,
        chainlink_mid_price
      FROM ${TABLE}
      WHERE base_symbol = ?
        AND market_slug = ?
      ORDER BY captured_at_ts ASC
    `,
    [token, marketSlug]
  );

  return rows.map((row) => ({
    ts: Number(row.captured_at_ts),
    up_buy_price: row.up_buy_price === null ? null : Number(row.up_buy_price),
    chainlink_mid_price:
      row.chainlink_mid_price === null ? null : Number(row.chainlink_mid_price)
  }));
}

export async function getPriceSeriesByWindow(
  token: string,
  marketStartTs: number,
  marketEndTs: number
): Promise<PricePoint[]> {
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `
      SELECT
        captured_at_ts,
        up_buy_price,
        chainlink_mid_price
      FROM ${TABLE}
      WHERE base_symbol = ?
        AND market_start_ts = ?
        AND market_end_ts = ?
      ORDER BY captured_at_ts ASC
    `,
    [token, marketStartTs, marketEndTs]
  );

  return rows.map((row) => ({
    ts: Number(row.captured_at_ts),
    up_buy_price: row.up_buy_price === null ? null : Number(row.up_buy_price),
    chainlink_mid_price:
      row.chainlink_mid_price === null ? null : Number(row.chainlink_mid_price)
  }));
}

export async function getMarketWindow(token: string, marketSlug: string): Promise<{
  market_start_ts: number;
  market_end_ts: number;
} | null> {
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `
      SELECT market_start_ts, market_end_ts
      FROM ${TABLE}
      WHERE base_symbol = ?
        AND market_slug = ?
      ORDER BY captured_at_ts DESC
      LIMIT 1
    `,
    [token, marketSlug]
  );

  if (rows.length === 0) {
    return null;
  }

  return {
    market_start_ts: Number(rows[0].market_start_ts),
    market_end_ts: Number(rows[0].market_end_ts)
  };
}

export async function getMarketSlugByWindow(
  token: string,
  marketStartTs: number,
  marketEndTs: number
): Promise<string | null> {
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `
      SELECT market_slug
      FROM ${TABLE}
      WHERE base_symbol = ?
        AND market_start_ts = ?
        AND market_end_ts = ?
      ORDER BY captured_at_ts DESC
      LIMIT 1
    `,
    [token, marketStartTs, marketEndTs]
  );
  if (rows.length === 0) {
    return null;
  }
  return String(rows[0].market_slug);
}
