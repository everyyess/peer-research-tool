import { NextRequest, NextResponse } from "next/server";
import YahooFinance from "yahoo-finance2";

/**
 * /api/peer-analysis
 *
 * POST { peers: [{ symbol, name }] } (2~8개 기업)
 *   → 사용자가 선택한 기업(Peer)별 성장·밸류에이션·수익성·재고 지표 일괄 수집
 *
 * 소스: Yahoo Finance (심볼당 quoteSummary 1회 + fundamentalsTimeSeries 2회, 6시간 캐시)
 *  - 분기 재무(매출·영업이익·재고·EPS)는 신형 timeseries API — 구형 statement history 모듈은
 *    2024년 이후 대부분 비어서 옴 (특히 KR 종목의 operatingIncome·inventory)
 *  - PER/PBR이 quoteSummary에 없으면 TTM EPS(분기 dilutedEPS 4개 합)·BPS(자본/발행주식)로 직접 계산
 *  - PER/PBR 52주 밴드는 52주 고저가 × 현재 EPS/BPS 근사 (연간 EPS 이력 아님 — 라벨에 명시)
 *  - 수주잔고는 표준 API 필드가 없어 v1 미지원 (DART 정기보고서 파싱 필요 — 2차)
 */

export const runtime = "nodejs";
export const maxDuration = 60;

const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

export type PeerQuarterPoint = {
  date: string;                    // yyyy-mm-dd (분기말)
  revenue: number | null;
  operatingIncome: number | null;
  inventory: number | null;
};

export type PeerAnnualPoint = {
  year: string;                    // yyyy
  revenue: number | null;
  operatingIncome: number | null;
  operatingMargin: number | null;  // %
};

export type PeerMetrics = {
  symbol: string;
  name: string;
  currency: string | null;
  financialCurrency: string | null;
  price: number | null;
  marketCap: number | null;

  // 성장
  revenueTtm: number | null;
  revenueGrowthYoY: number | null;  // % — 최근 분기 매출 vs 전년동기 (yahoo revenueGrowth)
  revenueGrowthQoQ: number | null;  // % — 최근 분기 vs 직전 분기
  epsGrowthFwd: number | null;      // % — 향후 1년 EPS 성장 컨센서스 (없으면 최근 이익성장)

  // 밸류에이션
  per: number | null;
  forwardPer: number | null;
  pbr: number | null;
  psr: number | null;
  pegRatio: number | null;

  // 52주 밴드 (현재 EPS/BPS 고정 근사)
  perHigh52: number | null;
  perLow52: number | null;
  pbrHigh52: number | null;
  pbrLow52: number | null;

  // 수익성·재무
  operatingMargin: number | null;   // %
  roe: number | null;               // %
  dividendYield: number | null;     // %
  debtToEquity: number | null;

  // 재고 (금융 등 미보유 업종은 null)
  inventoryQoQ: number | null;          // % — 최근 분기 재고 증감
  inventoryToQuarterRevenue: number | null; // % — 최근 분기 재고/분기 매출

  quarters: PeerQuarterPoint[];     // 오래된 → 최신 (최대 6)
  annuals: PeerAnnualPoint[];       // 오래된 → 최신 (최대 4)
  error?: string;                   // 개별 종목 수집 실패 사유
};

export type PeerAnalysisResponse = {
  asOf: string;
  peers: PeerMetrics[];
};

// ── 캐시 (심볼 단위, 6시간) ───────────────────────────────────────────────────
const peerCache = new Map<string, { data: PeerMetrics; ts: number }>();
const PEER_TTL_MS = 6 * 60 * 60 * 1000;

function toNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function pct(v: number | null): number | null {
  return v == null ? null : v * 100;
}

function growthPct(cur: number | null, prev: number | null): number | null {
  if (cur == null || prev == null || prev === 0) return null;
  return (cur / Math.abs(prev) - 1) * 100;
}

/** yahoo 날짜 필드(Date | string | epoch초) → yyyy-mm-dd */
function toDateStr(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "string") return v.slice(0, 10);
  if (typeof v === "number") return new Date(v * 1000).toISOString().slice(0, 10);
  return "";
}

// quoteSummary 응답에서 쓰는 부분만 구조화 (라이브러리 타입이 모듈 조합에 따라 느슨해 unknown 캐스팅)
type Summary = {
  price?: { longName?: string; shortName?: string; regularMarketPrice?: number; currency?: string; marketCap?: number };
  summaryDetail?: {
    trailingPE?: number; dividendYield?: number;
    fiftyTwoWeekHigh?: number; fiftyTwoWeekLow?: number;
    priceToSalesTrailing12Months?: number;
  };
  defaultKeyStatistics?: {
    priceToBook?: number; forwardPE?: number; pegRatio?: number;
    earningsQuarterlyGrowth?: number;
  };
  financialData?: {
    totalRevenue?: number; revenueGrowth?: number; earningsGrowth?: number;
    operatingMargins?: number; returnOnEquity?: number; debtToEquity?: number;
    financialCurrency?: string;
  };
  earningsTrend?: { trend?: Array<{ period?: string; growth?: number }> };
};

// fundamentalsTimeSeries 행에서 쓰는 필드 (validateResult:false로 받아 직접 추출)
type TsRow = Record<string, unknown> & { date?: unknown };

/** timeseries 행들을 분기말 날짜 기준으로 병합 (financials/balance-sheet가 별도 행으로 올 수 있음) */
function mergeTsRows(rows: TsRow[]): Map<string, TsRow> {
  const byDate = new Map<string, TsRow>();
  for (const r of rows) {
    const date = toDateStr(r.date);
    if (!date) continue;
    byDate.set(date, { ...(byDate.get(date) ?? {}), ...r, date });
  }
  return byDate;
}

async function fetchPeerMetrics(symbol: string, name: string): Promise<PeerMetrics> {
  const cached = peerCache.get(symbol);
  if (cached && Date.now() - cached.ts < PEER_TTL_MS) return { ...cached.data, name };

  const base: PeerMetrics = {
    symbol, name, currency: null, financialCurrency: null, price: null, marketCap: null,
    revenueTtm: null, revenueGrowthYoY: null, revenueGrowthQoQ: null, epsGrowthFwd: null,
    per: null, forwardPer: null, pbr: null, psr: null, pegRatio: null,
    perHigh52: null, perLow52: null, pbrHigh52: null, pbrLow52: null,
    operatingMargin: null, roe: null, dividendYield: null, debtToEquity: null,
    inventoryQoQ: null, inventoryToQuarterRevenue: null,
    quarters: [], annuals: [],
  };

  try {
    const now = Date.now();
    const iso = (msAgo: number) => new Date(now - msAgo).toISOString().slice(0, 10);
    const [summary, qRowsRaw, aRowsRaw] = await Promise.all([
      yahooFinance.quoteSummary(symbol, {
        modules: ["price", "summaryDetail", "defaultKeyStatistics", "financialData", "earningsTrend"],
      }) as unknown as Promise<Summary>,
      // 최근 ~18개월 분기 재무+재무상태표 (5개 분기 확보 → 분기 YoY 계산 가능)
      (yahooFinance.fundamentalsTimeSeries(symbol, {
        period1: iso(560 * 86400_000), type: "quarterly", module: "all",
      }, { validateResult: false }) as Promise<TsRow[]>).catch(() => [] as TsRow[]),
      // 최근 5년 연간 손익
      (yahooFinance.fundamentalsTimeSeries(symbol, {
        period1: iso(5 * 366 * 86400_000), type: "annual", module: "financials",
      }, { validateResult: false }) as Promise<TsRow[]>).catch(() => [] as TsRow[]),
    ]);

    const price = toNum(summary.price?.regularMarketPrice);
    base.currency = summary.price?.currency ?? null;
    base.financialCurrency = summary.financialData?.financialCurrency ?? null;
    base.price = price;
    base.marketCap = toNum(summary.price?.marketCap);

    base.revenueTtm = toNum(summary.financialData?.totalRevenue);
    base.revenueGrowthYoY = pct(toNum(summary.financialData?.revenueGrowth));
    base.operatingMargin = pct(toNum(summary.financialData?.operatingMargins));
    base.roe = pct(toNum(summary.financialData?.returnOnEquity));
    base.debtToEquity = toNum(summary.financialData?.debtToEquity);

    base.per = toNum(summary.summaryDetail?.trailingPE);
    base.forwardPer = toNum(summary.defaultKeyStatistics?.forwardPE);
    base.pbr = toNum(summary.defaultKeyStatistics?.priceToBook);
    base.psr = toNum(summary.summaryDetail?.priceToSalesTrailing12Months);
    base.pegRatio = toNum(summary.defaultKeyStatistics?.pegRatio);
    base.dividendYield = pct(toNum(summary.summaryDetail?.dividendYield));

    // EPS 성장: 컨센서스(+1y) 우선, 없으면 최근 이익 성장
    const trendPlus1y = summary.earningsTrend?.trend?.find((t) => t.period === "+1y");
    base.epsGrowthFwd =
      pct(toNum(trendPlus1y?.growth)) ??
      pct(toNum(summary.financialData?.earningsGrowth)) ??
      pct(toNum(summary.defaultKeyStatistics?.earningsQuarterlyGrowth));

    // 분기 재무 — timeseries 행을 분기말 날짜로 병합 후 오래된→최신 정렬
    const qMerged = [...mergeTsRows(qRowsRaw).values()]
      .map((r) => ({
        date: toDateStr(r.date),
        revenue: toNum(r.totalRevenue),
        operatingIncome: toNum(r.operatingIncome),
        inventory: toNum(r.inventory),
        dilutedEPS: toNum(r.dilutedEPS) ?? toNum(r.basicEPS),
        netIncome: toNum(r.netIncomeCommonStockholders) ?? toNum(r.netIncome),
        stockholdersEquity: toNum(r.stockholdersEquity),
        shareIssued: toNum(r.shareIssued),
      }))
      .filter((r) => r.date)
      .sort((a, b) => a.date.localeCompare(b.date));

    base.quarters = qMerged.slice(-6).map((r) => ({
      date: r.date, revenue: r.revenue, operatingIncome: r.operatingIncome, inventory: r.inventory,
    }));

    const qLast = qMerged[qMerged.length - 1];
    const qPrev = qMerged[qMerged.length - 2];
    if (qLast && qPrev) {
      base.revenueGrowthQoQ = growthPct(qLast.revenue, qPrev.revenue);
      base.inventoryQoQ = growthPct(qLast.inventory, qPrev.inventory);
    }
    if (qLast && qLast.inventory != null && qLast.revenue != null && qLast.revenue > 0) {
      base.inventoryToQuarterRevenue = (qLast.inventory / qLast.revenue) * 100;
    }
    // 분기 YoY 폴백: quoteSummary revenueGrowth 부재 시 최근 분기 vs 4개 분기 전
    if (base.revenueGrowthYoY == null && qMerged.length >= 5) {
      base.revenueGrowthYoY = growthPct(qLast.revenue, qMerged[qMerged.length - 5].revenue);
    }

    // PER/PBR 폴백 — TTM EPS(최근 4개 분기 합) · BPS(자본/발행주식)로 직접 계산
    if (base.per == null && price != null && price > 0) {
      const eps4 = qMerged.slice(-4).map((r) => r.dilutedEPS);
      if (eps4.length === 4 && eps4.every((v) => v != null)) {
        const ttmEps = (eps4 as number[]).reduce((s, v) => s + v, 0);
        if (ttmEps > 0) base.per = price / ttmEps;
      }
    }
    // 2차 폴백: 시총 ÷ TTM 순이익 (KR 종목은 EPS 필드도 비는 경우가 많음)
    if (base.per == null && base.marketCap != null && base.marketCap > 0) {
      const ni4 = qMerged.slice(-4).map((r) => r.netIncome);
      if (ni4.length === 4 && ni4.every((v) => v != null)) {
        const ttmNi = (ni4 as number[]).reduce((s, v) => s + v, 0);
        if (ttmNi > 0) base.per = base.marketCap / ttmNi;
      }
    }
    if (base.pbr == null && price != null && price > 0 && qLast?.stockholdersEquity != null && qLast.shareIssued != null && qLast.shareIssued > 0) {
      const bps = qLast.stockholdersEquity / qLast.shareIssued;
      if (bps > 0) base.pbr = price / bps;
    }

    // 52주 밴드 — 현재 EPS/BPS 고정 근사: PER·PBR에 (고가/현재가)·(저가/현재가) 배율 적용
    const high52 = toNum(summary.summaryDetail?.fiftyTwoWeekHigh);
    const low52 = toNum(summary.summaryDetail?.fiftyTwoWeekLow);
    if (price != null && price > 0 && high52 != null && low52 != null) {
      if (base.per != null && base.per > 0) {
        base.perHigh52 = base.per * (high52 / price);
        base.perLow52 = base.per * (low52 / price);
      }
      if (base.pbr != null && base.pbr > 0) {
        base.pbrHigh52 = base.pbr * (high52 / price);
        base.pbrLow52 = base.pbr * (low52 / price);
      }
    }

    // 연간 재무 (오래된 순 정렬 후 최근 4개)
    const annuals = [...mergeTsRows(aRowsRaw).values()]
      .map((r) => {
        const revenue = toNum(r.totalRevenue);
        const operatingIncome = toNum(r.operatingIncome);
        return {
          year: toDateStr(r.date).slice(0, 4),
          revenue,
          operatingIncome,
          operatingMargin: revenue != null && revenue > 0 && operatingIncome != null
            ? (operatingIncome / revenue) * 100
            : null,
        };
      })
      .filter((a) => a.year)
      .sort((a, b) => a.year.localeCompare(b.year));
    base.annuals = annuals.slice(-4);

    // 영업이익률 폴백: quoteSummary 부재 시 최근 연간 마진
    if (base.operatingMargin == null && base.annuals.length) {
      base.operatingMargin = base.annuals[base.annuals.length - 1].operatingMargin;
    }
  } catch (err) {
    base.error = err instanceof Error ? err.message.slice(0, 120) : "수집 실패";
  }

  // 오류 응답은 캐시하지 않음 — 다음 요청에서 재시도
  if (!base.error) peerCache.set(symbol, { data: base, ts: Date.now() });
  return base;
}

export async function POST(req: NextRequest) {
  let input: unknown;
  try {
    input = await req.json();
  } catch {
    return NextResponse.json({ error: "유효한 JSON 요청이 필요합니다." }, { status: 400 });
  }

  if (typeof input !== "object" || input === null || !("peers" in input) || !Array.isArray(input.peers)) {
    return NextResponse.json({ error: "peers 배열이 필요합니다." }, { status: 400 });
  }
  if (input.peers.length < 2 || input.peers.length > 8) {
    return NextResponse.json({ error: "비교 기업은 최소 2개, 최대 8개여야 합니다." }, { status: 400 });
  }

  const selectedPeers: Array<{ symbol: string; name: string }> = [];
  const symbols = new Set<string>();
  for (const peer of input.peers) {
    if (
      typeof peer !== "object" || peer === null ||
      typeof peer.symbol !== "string" || !peer.symbol.trim() ||
      typeof peer.name !== "string" || !peer.name.trim()
    ) {
      return NextResponse.json({ error: "각 기업의 symbol과 name은 비어 있지 않은 문자열이어야 합니다." }, { status: 400 });
    }
    const symbol = peer.symbol.trim().toUpperCase();
    if (symbols.has(symbol)) {
      return NextResponse.json({ error: "중복된 기업 심볼은 사용할 수 없습니다." }, { status: 400 });
    }
    symbols.add(symbol);
    selectedPeers.push({ symbol, name: peer.name.trim() });
  }

  const peers = await Promise.all(selectedPeers.map((peer) => fetchPeerMetrics(peer.symbol, peer.name)));
  const body: PeerAnalysisResponse = {
    asOf: new Date().toISOString(),
    peers,
  };
  return NextResponse.json(body);
}
