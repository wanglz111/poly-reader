import mysql, { Pool, RowDataPacket } from "mysql2/promise";

import type { HourBucket, MarketOption, PricePoint } from "@/types/api";

const DEFAULT_POLYMARKET_TABLE = "polymarket_prices";
const DEFAULT_CHAINLINK_REPORTS_TABLE = "chainlink_live_reports";
const DEFAULT_TABLE_DATE_TZ = "+08:00";
const TABLE_CACHE_TTL_MS = 60_000;
const SAFE_IDENTIFIER_RE = /^[A-Za-z0-9_]+$/;
const CHAINLINK_MID_PRICE_SQL = `
  CASE
    WHEN chainlink_price REGEXP '^[0-9]+$' THEN
      CAST(chainlink_price AS DECIMAL(65, 18)) / POW(10, chainlink_price_unit_scale)
    ELSE
      CAST(chainlink_price AS DECIMAL(65, 18))
  END
`;

type DbConfig = {
  chainlinkReportsBaseTable: string;
  databaseName: string;
  polymarketBaseTable: string;
  tableTimezoneMinutes: number;
};

type SqlFragment = {
  params: unknown[];
  sql: string;
};

declare global {
  // eslint-disable-next-line no-var
  var __polyReaderPool: Pool | undefined;
  // eslint-disable-next-line no-var
  var __polyReaderTableCache: Map<string, { expiresAt: number; tables: string[] }> | undefined;
}

function ensureSafeIdentifier(name: string, label: string): string {
  if (!name || !SAFE_IDENTIFIER_RE.test(name)) {
    throw new Error(`invalid ${label}`);
  }
  return name;
}

function parseTimezoneOffsetMinutes(value: string | undefined): number {
  const rawValue = value?.trim() || DEFAULT_TABLE_DATE_TZ;
  const normalized = rawValue.toUpperCase();
  if (["Z", "UTC", "+00", "+0000", "+00:00"].includes(normalized)) {
    return 0;
  }

  const match = normalized.match(/^([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) {
    throw new Error("invalid MYSQL_TABLE_DATE_TZ");
  }

  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? "00");
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours > 23 || minutes > 59) {
    throw new Error("invalid MYSQL_TABLE_DATE_TZ");
  }
  return sign * (hours * 60 + minutes);
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

function getDatabaseName(): string {
  if (process.env.MYSQL_DATABASE && process.env.MYSQL_DATABASE.trim()) {
    return process.env.MYSQL_DATABASE.trim();
  }

  const uri = getConnectionUri();
  if (!uri) {
    throw new Error("MySQL env is not configured");
  }

  try {
    const url = new URL(uri);
    const pathname = url.pathname.replace(/^\/+/, "");
    if (!pathname) {
      throw new Error("missing database");
    }
    return pathname;
  } catch {
    throw new Error("MySQL env is not configured");
  }
}

function getDbConfig(): DbConfig {
  return {
    chainlinkReportsBaseTable: ensureSafeIdentifier(
      process.env.CHAINLINK_REPORTS_TABLE ?? process.env.MYSQL_TABLE ?? DEFAULT_CHAINLINK_REPORTS_TABLE,
      "CHAINLINK_REPORTS_TABLE"
    ),
    databaseName: getDatabaseName(),
    polymarketBaseTable: ensureSafeIdentifier(
      process.env.POLYMARKET_TABLE ?? DEFAULT_POLYMARKET_TABLE,
      "POLYMARKET_TABLE"
    ),
    tableTimezoneMinutes: parseTimezoneOffsetMinutes(process.env.MYSQL_TABLE_DATE_TZ)
  };
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
  const connectTimeout = Number(process.env.MYSQL_CONNECT_TIMEOUT_SEC ?? "5") * 1000;
  const readTimeout = Number(process.env.MYSQL_READ_TIMEOUT_SEC ?? "5") * 1000;
  const writeTimeout = Number(process.env.MYSQL_WRITE_TIMEOUT_SEC ?? "5") * 1000;
  const networkTimeout = Math.max(connectTimeout, readTimeout, writeTimeout);

  global.__polyReaderPool = mysql.createPool({
    uri,
    waitForConnections: true,
    connectionLimit: 8,
    queueLimit: 0,
    timezone: "Z",
    ssl,
    connectTimeout: Number.isFinite(networkTimeout) && networkTimeout > 0 ? networkTimeout : 5000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
  });

  return global.__polyReaderPool;
}

function getTableCache() {
  if (!global.__polyReaderTableCache) {
    global.__polyReaderTableCache = new Map();
  }
  return global.__polyReaderTableCache;
}

function coerceTableName(row: RowDataPacket): string | null {
  const direct =
    row.table_name ??
    row.TABLE_NAME ??
    row.Table_name;
  const fallback = direct ?? Object.values(row).find((value) => typeof value === "string");
  if (typeof fallback !== "string") {
    return null;
  }
  return SAFE_IDENTIFIER_RE.test(fallback) ? fallback : null;
}

function emptyChainlinkFragment(): SqlFragment {
  return {
    params: [],
    sql: `
      SELECT
        CAST(NULL AS CHAR(16)) AS symbol_norm,
        CAST(NULL AS SIGNED) AS ts_unix,
        CAST(NULL AS CHAR(128)) AS chainlink_price,
        18 AS chainlink_price_unit_scale
      WHERE 1 = 0
    `
  };
}

function emptyPolymarketResult<T>(): T[] {
  return [];
}

function getDateSuffixForDayIndex(dayIndex: number): string {
  return new Date(dayIndex * 86_400_000).toISOString().slice(0, 10).replace(/-/g, "");
}

function getDayIndex(tsUnix: number, offsetMinutes: number): number {
  return Math.floor((tsUnix + offsetMinutes * 60) / 86_400);
}

function buildRangeTableNames(baseTable: string, startTs: number, endTsExclusive: number, offsetMinutes: number) {
  const names = new Set<string>();
  const startDay = getDayIndex(startTs, offsetMinutes);
  const endDay = getDayIndex(endTsExclusive - 1, offsetMinutes);
  for (let day = startDay; day <= endDay; day += 1) {
    names.add(`${baseTable}_${getDateSuffixForDayIndex(day)}`);
  }
  return names;
}

function extractMarketStartTs(marketSlug: string): number | null {
  const match = marketSlug.match(/-(\d{9,12})$/);
  if (!match) {
    return null;
  }
  const ts = Number(match[1]);
  return Number.isInteger(ts) ? ts : null;
}

async function listAvailableTables(baseTable: string): Promise<string[]> {
  const cfg = getDbConfig();
  const cacheKey = `${cfg.databaseName}:${baseTable}`;
  const cache = getTableCache();
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.tables;
  }

  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = ?
        AND table_name REGEXP ?
      ORDER BY table_name ASC
    `,
    [cfg.databaseName, `^${baseTable}_[0-9]{8}$`]
  );

  const tables = rows
    .map(coerceTableName)
    .filter((table): table is string => table !== null);
  cache.set(cacheKey, {
    expiresAt: now + TABLE_CACHE_TTL_MS,
    tables
  });
  return tables;
}

async function getTablesForRange(
  baseTable: string,
  startTs: number,
  endTsExclusive: number
): Promise<string[]> {
  if (endTsExclusive <= startTs) {
    return [];
  }

  const cfg = getDbConfig();
  const candidates = buildRangeTableNames(
    baseTable,
    startTs,
    endTsExclusive,
    cfg.tableTimezoneMinutes
  );
  const available = await listAvailableTables(baseTable);
  return available.filter((table) => candidates.has(table));
}

function buildUnionQuery(
  tables: string[],
  buildSelect: (table: string) => string,
  buildParams: () => unknown[]
): SqlFragment {
  const sqlParts: string[] = [];
  const params: unknown[] = [];

  for (const table of tables) {
    sqlParts.push(buildSelect(table));
    params.push(...buildParams());
  }

  return {
    params,
    sql: sqlParts.join(" UNION ALL ")
  };
}

function mapPriceSeriesRows(rows: RowDataPacket[]): PricePoint[] {
  return rows.map((row) => ({
    ts: Number(row.ts_unix),
    up_buy_price: row.up_buy_price === null ? null : Number(row.up_buy_price),
    chainlink_mid_price:
      row.chainlink_mid_price === null ? null : Number(row.chainlink_mid_price)
  }));
}

async function getLatestTsForToken(token: string): Promise<number | null> {
  const cfg = getDbConfig();
  const tables = await listAvailableTables(cfg.polymarketBaseTable);
  if (tables.length === 0) {
    return null;
  }

  const fragment = buildUnionQuery(
    tables,
    (table) => `
      SELECT MAX(captured_at_ts) AS max_ts
      FROM \`${table}\`
      WHERE LOWER(symbol) = ?
    `,
    () => [token]
  );
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `
      SELECT MAX(max_ts) AS max_ts
      FROM (${fragment.sql}) recent
    `,
    fragment.params
  );

  const value = rows[0]?.max_ts;
  return value === null || value === undefined ? null : Number(value);
}

async function getJoinedPriceSeries(
  token: string,
  polymarketFilter: {
    endTsExclusive?: number;
    marketEndTs?: number;
    marketSlug?: string;
    marketStartTs?: number;
    startTs?: number;
  }
): Promise<PricePoint[]> {
  const cfg = getDbConfig();
  const rangeStartTs = polymarketFilter.startTs;
  const rangeEndTsExclusive = polymarketFilter.endTsExclusive;
  const polymarketTables =
    rangeStartTs !== undefined && rangeEndTsExclusive !== undefined
      ? await getTablesForRange(cfg.polymarketBaseTable, rangeStartTs, rangeEndTsExclusive)
      : await listAvailableTables(cfg.polymarketBaseTable);
  if (polymarketTables.length === 0) {
    return emptyPolymarketResult();
  }

  const polyWhere: string[] = ["LOWER(symbol) = ?"];
  const polyParams: unknown[] = [token];
  if (polymarketFilter.marketSlug) {
    polyWhere.push("market_slug = ?");
    polyParams.push(polymarketFilter.marketSlug);
  }
  if (polymarketFilter.marketStartTs !== undefined) {
    polyWhere.push("market_start_ts = ?");
    polyParams.push(polymarketFilter.marketStartTs);
  }
  if (polymarketFilter.marketEndTs !== undefined) {
    polyWhere.push("market_end_ts = ?");
    polyParams.push(polymarketFilter.marketEndTs);
  }
  if (rangeStartTs !== undefined) {
    polyWhere.push("captured_at_ts >= ?");
    polyParams.push(rangeStartTs);
  }
  if (rangeEndTsExclusive !== undefined) {
    polyWhere.push("captured_at_ts < ?");
    polyParams.push(rangeEndTsExclusive);
  }

  const polymarketFragment = buildUnionQuery(
    polymarketTables,
    (table) => `
      SELECT
        LOWER(symbol) AS symbol_norm,
        captured_at_ts AS ts_unix,
        market_slug,
        market_start_ts,
        market_end_ts,
        up_buy_price
      FROM \`${table}\`
      WHERE ${polyWhere.join(" AND ")}
    `,
    () => polyParams
  );

  const chainlinkTables =
    rangeStartTs !== undefined && rangeEndTsExclusive !== undefined
      ? await getTablesForRange(cfg.chainlinkReportsBaseTable, rangeStartTs, rangeEndTsExclusive)
      : [];
  const chainlinkFragment =
    chainlinkTables.length === 0
      ? emptyChainlinkFragment()
      : buildUnionQuery(
          chainlinkTables,
          (table) => `
            SELECT
              LOWER(symbol) AS symbol_norm,
              ts_unix,
              price AS chainlink_price,
              18 AS chainlink_price_unit_scale
            FROM \`${table}\`
            WHERE LOWER(symbol) = ?
              AND ts_unix >= ?
              AND ts_unix < ?
          `,
          () => [token, rangeStartTs, rangeEndTsExclusive]
        );

  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `
      SELECT
        p.ts_unix,
        p.up_buy_price,
        ${CHAINLINK_MID_PRICE_SQL} AS chainlink_mid_price
      FROM (${polymarketFragment.sql}) p
      LEFT JOIN (${chainlinkFragment.sql}) c
        ON c.symbol_norm = p.symbol_norm
       AND c.ts_unix = p.ts_unix
      ORDER BY p.ts_unix ASC
    `,
    [...polymarketFragment.params, ...chainlinkFragment.params]
  );

  return mapPriceSeriesRows(rows);
}

export async function listTokens(): Promise<string[]> {
  const cfg = getDbConfig();
  const tables = await listAvailableTables(cfg.polymarketBaseTable);
  if (tables.length === 0) {
    return [];
  }

  const fragment = buildUnionQuery(
    tables,
    (table) => `SELECT DISTINCT LOWER(symbol) AS symbol_norm FROM \`${table}\``,
    () => []
  );
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `
      SELECT DISTINCT symbol_norm
      FROM (${fragment.sql}) symbols
      ORDER BY symbol_norm
    `
  );

  return rows.map((row) => String(row.symbol_norm));
}

export async function listHourBuckets(
  token: string,
  recentHours = 24 * 14,
  limit = 24 * 30
): Promise<HourBucket[]> {
  const cfg = getDbConfig();
  const latestTs = await getLatestTsForToken(token);
  if (latestTs === null) {
    return [];
  }

  const thresholdTs = Math.max(0, latestTs - recentHours * 3600);
  const tables = await getTablesForRange(cfg.polymarketBaseTable, thresholdTs, latestTs + 1);
  if (tables.length === 0) {
    return [];
  }

  const fragment = buildUnionQuery(
    tables,
    (table) => `
      SELECT
        FLOOR(captured_at_ts / 3600) * 3600 AS hour_start_ts,
        COUNT(*) AS points
      FROM \`${table}\`
      WHERE LOWER(symbol) = ?
        AND captured_at_ts >= ?
      GROUP BY FLOOR(captured_at_ts / 3600)
    `,
    () => [token, thresholdTs]
  );
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `
      SELECT
        hour_start_ts,
        hour_start_ts + 3600 AS hour_end_ts,
        SUM(points) AS points
      FROM (${fragment.sql}) hours
      GROUP BY hour_start_ts
      ORDER BY hour_start_ts DESC
      LIMIT ?
    `,
    [...fragment.params, limit]
  );

  return rows.map((row) => ({
    hour_start_ts: Number(row.hour_start_ts),
    hour_end_ts: Number(row.hour_end_ts),
    points: Number(row.points)
  }));
}

export async function listMarketsByHour(
  token: string,
  hourStartTs: number,
  limit = 40
): Promise<MarketOption[]> {
  const cfg = getDbConfig();
  const nowTs = Math.floor(Date.now() / 1000);
  const tables = await getTablesForRange(cfg.polymarketBaseTable, hourStartTs, hourStartTs + 3600);
  if (tables.length === 0) {
    return [];
  }

  const fragment = buildUnionQuery(
    tables,
    (table) => `
      SELECT
        market_slug,
        market_start_ts,
        market_end_ts,
        COUNT(*) AS points
      FROM \`${table}\`
      WHERE LOWER(symbol) = ?
        AND market_start_ts >= ?
        AND market_start_ts < ?
        AND market_end_ts <= ?
      GROUP BY market_slug, market_start_ts, market_end_ts
    `,
    () => [token, hourStartTs, hourStartTs + 3600, nowTs]
  );
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `
      SELECT
        market_slug,
        market_start_ts,
        market_end_ts,
        SUM(points) AS points
      FROM (${fragment.sql}) markets
      GROUP BY market_slug, market_start_ts, market_end_ts
      ORDER BY market_start_ts DESC
      LIMIT ?
    `,
    [...fragment.params, limit]
  );

  return rows.map((row) => ({
    market_slug: String(row.market_slug),
    market_start_ts: Number(row.market_start_ts),
    market_end_ts: Number(row.market_end_ts),
    points: Number(row.points)
  }));
}

export async function getPriceSeries(token: string, marketSlug: string): Promise<PricePoint[]> {
  const marketStartTs = extractMarketStartTs(marketSlug);
  return getJoinedPriceSeries(token, {
    endTsExclusive: marketStartTs === null ? undefined : marketStartTs + 300,
    marketSlug,
    startTs: marketStartTs ?? undefined
  });
}

export async function getPriceSeriesByWindow(
  token: string,
  marketStartTs: number,
  marketEndTs: number
): Promise<PricePoint[]> {
  return getJoinedPriceSeries(token, {
    endTsExclusive: marketEndTs,
    marketEndTs,
    marketStartTs,
    startTs: marketStartTs
  });
}

export async function getPriceSeriesByHour(token: string, hourStartTs: number): Promise<PricePoint[]> {
  const hourEndTs = hourStartTs + 3600;
  return getJoinedPriceSeries(token, {
    endTsExclusive: hourEndTs,
    startTs: hourStartTs
  });
}

export async function getMarketWindow(
  token: string,
  marketSlug: string
): Promise<{
  market_start_ts: number;
  market_end_ts: number;
} | null> {
  const cfg = getDbConfig();
  const marketStartTs = extractMarketStartTs(marketSlug);
  const tables =
    marketStartTs === null
      ? await listAvailableTables(cfg.polymarketBaseTable)
      : await getTablesForRange(cfg.polymarketBaseTable, marketStartTs, marketStartTs + 300);
  if (tables.length === 0) {
    return null;
  }

  const fragment = buildUnionQuery(
    tables,
    (table) => `
      SELECT market_start_ts, market_end_ts, captured_at_ts AS ts_unix
      FROM \`${table}\`
      WHERE LOWER(symbol) = ?
        AND market_slug = ?
    `,
    () => [token, marketSlug]
  );
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `
      SELECT market_start_ts, market_end_ts
      FROM (${fragment.sql}) markets
      ORDER BY ts_unix DESC
      LIMIT 1
    `,
    fragment.params
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
  const cfg = getDbConfig();
  const tables = await getTablesForRange(cfg.polymarketBaseTable, marketStartTs, marketEndTs);
  if (tables.length === 0) {
    return null;
  }

  const fragment = buildUnionQuery(
    tables,
    (table) => `
      SELECT market_slug, captured_at_ts AS ts_unix
      FROM \`${table}\`
      WHERE LOWER(symbol) = ?
        AND market_start_ts = ?
        AND market_end_ts = ?
    `,
    () => [token, marketStartTs, marketEndTs]
  );
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `
      SELECT market_slug
      FROM (${fragment.sql}) markets
      ORDER BY ts_unix DESC
      LIMIT 1
    `,
    fragment.params
  );

  if (rows.length === 0) {
    return null;
  }
  return String(rows[0].market_slug);
}

export type ClosedMarketRef = {
  token: string;
  market_slug: string;
  market_start_ts: number;
  market_end_ts: number;
};

export async function listClosedMarketsAfter(
  cursor: { market_end_ts: number; token: string; market_slug: string },
  limit = 200
): Promise<ClosedMarketRef[]> {
  const cfg = getDbConfig();
  const nowTs = Math.floor(Date.now() / 1000);

  const tables = await getTablesForRange(
    cfg.polymarketBaseTable,
    cursor.market_end_ts + 1,
    nowTs + 1
  );
  if (tables.length === 0) {
    return [];
  }

  const fragment = buildUnionQuery(
    tables,
    (table) => `
      SELECT
        LOWER(symbol) AS symbol_norm,
        market_slug,
        market_start_ts,
        market_end_ts
      FROM \`${table}\`
      WHERE market_end_ts <= ?
        AND (
          market_end_ts > ?
          OR (market_end_ts = ? AND LOWER(symbol) > ?)
          OR (market_end_ts = ? AND LOWER(symbol) = ? AND market_slug > ?)
        )
      GROUP BY LOWER(symbol), market_slug, market_start_ts, market_end_ts
    `,
    () => [
      nowTs,
      cursor.market_end_ts,
      cursor.market_end_ts,
      cursor.token,
      cursor.market_end_ts,
      cursor.token,
      cursor.market_slug
    ]
  );

  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `
      SELECT
        symbol_norm,
        market_slug,
        market_start_ts,
        market_end_ts
      FROM (${fragment.sql}) markets
      GROUP BY symbol_norm, market_slug, market_start_ts, market_end_ts
      ORDER BY market_end_ts ASC, symbol_norm ASC, market_slug ASC
      LIMIT ?
    `,
    [...fragment.params, limit]
  );

  return rows.map((row) => ({
    token: String(row.symbol_norm),
    market_slug: String(row.market_slug),
    market_start_ts: Number(row.market_start_ts),
    market_end_ts: Number(row.market_end_ts)
  }));
}
