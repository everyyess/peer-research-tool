export const DART_HISTORY_YEARS = ["2022", "2023", "2024", "2025"] as const;
export type HistoryPeer = { symbol: string; name: string };
export type DartHistoryPoint = {
  year: string; revenue: number | null; operatingIncome: number | null;
  operatingMargin: number | null; fsDiv: "CFS" | "OFS" | null; error?: string;
};
export type DartPeerHistory = HistoryPeer & { points: DartHistoryPoint[] };
const TTL = 6 * 60 * 60 * 1000;
const cache = new Map<string, { point: DartHistoryPoint; expiresAt: number }>();
const pending = new Map<string, Promise<DartHistoryPoint>>();
const numberOrNull = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
const emptyPoint = (year: string, error: string): DartHistoryPoint => ({
  year, revenue: null, operatingIncome: null, operatingMargin: null, fsDiv: null, error,
});
let running = 0;
const waiting: Array<() => void> = [];
async function limited<T>(task: () => Promise<T>): Promise<T> {
  if (running >= 4) await new Promise<void>(resolve => waiting.push(resolve));
  else running++;
  try { return await task(); }
  finally { const next = waiting.shift(); if (next) next(); else running--; }
}
async function getYear(stockCode: string, year: string): Promise<DartHistoryPoint> {
  const key = stockCode + ":" + year + ":annual";
  const cached = cache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.point;
  if (pending.has(key)) return pending.get(key)!;
  const task = limited(async () => {
    try {
      // Reuse the financial API's six-hour server cache as well.
      const response = await fetch("/api/dart/financials?" + new URLSearchParams({
        stockCode, year, report: "annual",
      }), { signal: AbortSignal.timeout(180_000) });
      const body = await response.json();
      if (!response.ok) return emptyPoint(year, body.error || "DART 조회 실패 (" + response.status + ")");
      if (body.stockCode !== stockCode || body.businessYear !== year ||
          body.report !== "annual" || !body.financials || !["CFS", "OFS"].includes(body.fsDiv)) {
        return emptyPoint(year, "DART 기업·연도·보고서 응답 불일치");
      }
      const point: DartHistoryPoint = {
        year, fsDiv: body.fsDiv, revenue: numberOrNull(body.financials.revenue),
        operatingIncome: numberOrNull(body.financials.operatingIncome),
        operatingMargin: numberOrNull(body.financials.operatingMargin),
      };
      for (const [oldKey, entry] of cache) if (entry.expiresAt <= Date.now()) cache.delete(oldKey);
      if (cache.size >= 256) cache.delete(cache.keys().next().value!);
      cache.set(key, { point, expiresAt: Date.now() + TTL });
      return point;
    } catch (error) {
      return emptyPoint(year, error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
        ? "DART 조회 시간 초과" : "DART 재무 데이터를 조회하지 못했습니다.");
    }
  });
  pending.set(key, task);
  try { return await task; }
  finally { pending.delete(key); }
}
export async function loadDartPeerHistory(peers: HistoryPeer[]): Promise<DartPeerHistory[]> {
  return Promise.all(peers.map(async peer => {
    const stockCode = /^(\d{6})\.(KS|KQ)$/.exec(peer.symbol.toUpperCase())?.[1];
    const points = stockCode
      ? await Promise.all(DART_HISTORY_YEARS.map(year => getYear(stockCode, year)))
      : DART_HISTORY_YEARS.map(year => emptyPoint(year, "국내 .KS / .KQ 심볼만 지원"));
    return { ...peer, points };
  }));
}
export function dartHistoryChartData(histories: DartPeerHistory[]): Array<Record<string, string | number | null>> {
  return DART_HISTORY_YEARS.map(year => ({
    year, ...Object.fromEntries(histories.map((peer, i) => [
      "peer" + i, peer.points.find(point => point.year === year)?.operatingMargin ?? null,
    ])),
  }));
}
