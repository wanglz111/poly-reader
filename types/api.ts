export type TimezoneOption = "POLYMARKET" | "UTC8";

export type MarketOption = {
  market_slug: string;
  market_start_ts: number;
  market_end_ts: number;
  label: string;
  points: number;
};

export type PricePoint = {
  ts: number;
  up_buy_price: number | null;
  chainlink_mid_price: number | null;
};

export type PriceSeriesResponse = {
  meta: {
    token: string;
    market_slug: string;
    market_start_ts: number;
    market_end_ts: number;
    timezone: TimezoneOption;
  };
  series: PricePoint[];
};
