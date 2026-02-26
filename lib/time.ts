import type { TimezoneOption } from "@/types/api";

const UTC8_ZONE = "Asia/Shanghai";

export function parseTimezone(input: string | null): TimezoneOption {
  if (input === "UTC8") {
    return "UTC8";
  }
  return "POLYMARKET";
}

export function formatRangeLabel(
  startTs: number,
  endTs: number,
  timezone: TimezoneOption
): string {
  const zone = timezone === "UTC8" ? UTC8_ZONE : "UTC";
  const start = formatTs(startTs, zone);
  const end = formatTs(endTs, zone);
  return `${start} ~ ${end.slice(-5)}`;
}

export function formatPointTs(ts: number, timezone: TimezoneOption): string {
  const zone = timezone === "UTC8" ? UTC8_ZONE : "UTC";
  return formatTsFull(ts, zone);
}

function formatTs(ts: number, zone: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: zone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  })
    .format(new Date(ts * 1000))
    .replace("/", "-")
    .replace("/", "-");
}

function formatTsFull(ts: number, zone: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: zone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  })
    .format(new Date(ts * 1000))
    .replace("/", "-")
    .replace("/", "-");
}
