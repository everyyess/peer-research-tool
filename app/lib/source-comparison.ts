import type { PeerAnnualPoint, PeerMetrics } from "@/app/api/peer-analysis/route";

export const COMPARISON_YEAR = "2025";
export const COMPARISON_METRICS = [
  { key: "revenue", label: "매출", kind: "amount", yahoo: true },
  { key: "operatingIncome", label: "영업이익", kind: "amount", yahoo: true },
  { key: "operatingMargin", label: "영업이익률", kind: "percent", yahoo: true },
  { key: "netIncome", label: "순이익", kind: "amount", yahoo: false },
  { key: "inventory", label: "재고", kind: "amount", yahoo: false },
  { key: "totalAssets", label: "자산", kind: "amount", yahoo: false },
  { key: "totalLiabilities", label: "부채", kind: "amount", yahoo: false },
  { key: "totalEquity", label: "자본", kind: "amount", yahoo: false },
  { key: "debtRatio", label: "부채비율", kind: "percent", yahoo: false },
] as const;
export type ComparisonMetric = (typeof COMPARISON_METRICS)[number];
export type ComparisonPeer = { symbol: string; name: string };
export type DartComparisonData = {
  stockCode: string;
  corpCode: string;
  corpName: string;
  businessYear: string;
  report: string;
  fsDiv: "CFS" | "OFS";
  currency: string | null;
  financials: Record<ComparisonMetric["key"], number | null>;
};
export const finiteValue = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export function domesticStockCode(symbol: string): string | null {
  return /^(\d{6})\.(KS|KQ)$/.exec(symbol.trim().toUpperCase())?.[1] ?? null;
}
export function annual2025(peer?: PeerMetrics): PeerAnnualPoint | undefined {
  return peer?.annuals?.find(annual => annual.year === COMPARISON_YEAR);
}
export function yahooAnnualValue(peer: PeerMetrics | undefined, metric: ComparisonMetric): number | null {
  if (!metric.yahoo || peer?.error) return null;
  if (metric.kind === "amount" && peer?.financialCurrency !== "KRW") return null;
  const annual = annual2025(peer);
  return annual ? finiteValue(annual[metric.key]) : null;
}
export function dartAnnualValue(data: DartComparisonData | undefined, metric: ComparisonMetric): number | null {
  if (!data || data.businessYear !== COMPARISON_YEAR || data.report !== "annual") return null;
  if (metric.kind === "amount" && data.currency !== "KRW") return null;
  return finiteValue(data.financials[metric.key]);
}
export function sourceDifference(yahoo: number | null, dart: number | null, kind: ComparisonMetric["kind"]): number | null {
  if (yahoo === null || dart === null) return null;
  if (kind === "amount" && dart === 0) return null;
  return finiteValue(kind === "amount" ? (dart - yahoo) / Math.abs(dart) * 100 : dart - yahoo);
}
const fixed = (value: number) => value.toLocaleString("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function formatComparisonValue(value: number | null, kind: ComparisonMetric["kind"]): string {
  if (value === null) return "—";
  if (kind === "percent") return fixed(value) + "%";
  const magnitude = Math.abs(value);
  if (magnitude >= 1e12) return fixed(value / 1e12) + "조원";
  if (magnitude >= 1e8) return fixed(value / 1e8) + "억원";
  if (magnitude >= 1e4) return fixed(value / 1e4) + "만원";
  return fixed(value) + "원";
}
export function formatDifference(value: number | null, kind: ComparisonMetric["kind"]): string {
  if (value === null) return "—";
  const rounded = Number(value.toFixed(2));
  return (rounded > 0 ? "+" : "") + fixed(Object.is(rounded, -0) ? 0 : rounded) + (kind === "amount" ? "%" : "%p");
}
