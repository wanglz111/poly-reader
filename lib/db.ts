import mysql, { Pool, RowDataPacket } from "mysql2/promise";

import type { MarketOption, PricePoint } from "@/types/api";

const TABLE = "v_chainlink_polymarket_join";
const CHAINLINK_MID_PRICE_SQL = `
  CASE
    WHEN chainlink_price REGEXP '^[0-9]+$' THEN
      CAST(chainlink_price AS DECIMAL(65, 18)) / POW(10, chainlink_price_unit_scale)
    ELSE
      CAST(chainlink_price AS DECIMAL(65, 18))
  END
`;

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
    `SELECT DISTINCT symbol_norm FROM ${TABLE} ORDER BY symbol_norm`
  );
  return rows.map((row) => String(row.symbol_norm));
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
      WHERE symbol_norm = ?
        AND ts_unix >= (
          SELECT GREATEST(0, MAX(ts_unix) - ?)
          FROM ${TABLE}
          WHERE symbol_norm = ?
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
        ts_unix,
        up_buy_price,
        ${CHAINLINK_MID_PRICE_SQL} AS chainlink_mid_price
      FROM ${TABLE}
      WHERE symbol_norm = ?
        AND market_slug = ?
      ORDER BY ts_unix ASC
    `,
    [token, marketSlug]
  );

  return rows.map((row) => ({
    ts: Number(row.ts_unix),
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
        ts_unix,
        up_buy_price,
        ${CHAINLINK_MID_PRICE_SQL} AS chainlink_mid_price
      FROM ${TABLE}
      WHERE symbol_norm = ?
        AND market_start_ts = ?
        AND market_end_ts = ?
      ORDER BY ts_unix ASC
    `,
    [token, marketStartTs, marketEndTs]
  );

  return rows.map((row) => ({
    ts: Number(row.ts_unix),
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
      WHERE symbol_norm = ?
        AND market_slug = ?
      ORDER BY ts_unix DESC
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
      WHERE symbol_norm = ?
        AND market_start_ts = ?
        AND market_end_ts = ?
      ORDER BY ts_unix DESC
      LIMIT 1
    `,
    [token, marketStartTs, marketEndTs]
  );
  if (rows.length === 0) {
    return null;
  }
  return String(rows[0].market_slug);
}
