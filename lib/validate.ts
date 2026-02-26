import type { TimezoneOption } from "@/types/api";

export function requireToken(input: string | null): string {
  if (!input) {
    throw new Error("token is required");
  }
  const token = input.trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,16}$/.test(token)) {
    throw new Error("invalid token");
  }
  return token;
}

export function requireMarketSlug(input: string | null): string {
  if (!input) {
    throw new Error("market_slug is required");
  }
  const slug = input.trim();
  if (!/^[a-z0-9-]{6,160}$/.test(slug)) {
    throw new Error("invalid market_slug");
  }
  return slug;
}

export function requireTimezone(input: string | null): TimezoneOption {
  if (input === "UTC8") {
    return "UTC8";
  }
  if (input === "POLYMARKET" || input === null || input === "") {
    return "POLYMARKET";
  }
  throw new Error("invalid timezone");
}

export function parseUnixTs(
  input: string | null,
  field: string
): number | null {
  if (input === null || input.trim() === "") {
    return null;
  }
  const n = Number(input);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`invalid ${field}`);
  }
  return n;
}
