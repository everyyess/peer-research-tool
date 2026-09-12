import "server-only";
import { checkDartStatus, DartError, getCorpInfo, requestDart } from "./dart";

export const REPORT_CODES = {
  annual: "11011",
  q1: "11013",
  half: "11012",
  q3: "11014",
} as const;
export type Report = keyof typeof REPORT_CODES;
type FsDiv = "CFS" | "OFS";
type Row = Record<string, unknown>;
type AmountKey = "revenue" | "operatingIncome" | "netIncome" | "totalAssets" | "totalLiabilities" | "totalEquity" | "inventory";
type Financials = Record<AmountKey | "operatingMargin" | "debtRatio", number | null>;
type FinancialResponse = {
  stockCode: string;
  corpCode: string;
  corpName: string;
  businessYear: string;
  report: Report;
  fsDiv: FsDiv;
  currency: string | null;
  incomePeriod: "annual" | "yearToDate";
  financials: Financials;
};

const ACCOUNTS: Record<AmountKey, { statement: "income" | "balance"; ids: string[]; names: string[] }> = {
  revenue: { statement: "income", ids: ["ifrs-full_Revenue", "ifrs_Revenue", "ifrs-full_RevenueFromContractsWithCustomers"], names: ["매출액", "수익(매출액)", "매출", "영업수익", "영업수익(매출액)"] },
  operatingIncome: { statement: "income", ids: ["dart_OperatingIncomeLoss", "ifrs-full_OperatingIncomeLoss", "ifrs_OperatingIncomeLoss"], names: ["영업이익", "영업이익(손실)", "영업손익", "영업손실"] },
  netIncome: { statement: "income", ids: ["ifrs-full_ProfitLoss", "ifrs_ProfitLoss"], names: ["당기순이익", "당기순이익(손실)", "당기순손익", "당기순손실", "분기순이익", "분기순이익(손실)", "반기순이익", "반기순이익(손실)"] },
  totalAssets: { statement: "balance", ids: ["ifrs-full_Assets", "ifrs_Assets"], names: ["자산총계", "자산합계", "총자산"] },
  totalLiabilities: { statement: "balance", ids: ["ifrs-full_Liabilities", "ifrs_Liabilities"], names: ["부채총계", "부채합계", "총부채"] },
  totalEquity: { statement: "balance", ids: ["ifrs-full_Equity", "ifrs_Equity"], names: ["자본총계", "자본합계", "총자본"] },
  inventory: { statement: "balance", ids: ["ifrs-full_Inventories", "ifrs_Inventories"], names: ["재고자산", "유동재고자산", "재고자산합계"] },
};

export function parseDartAmount(value: unknown): number | null {
  if (typeof value !== "string") return null;
  let text = value.trim().replace(/,/g, "").replace(/−/g, "-");
  if (/^\(\d+(?:\.\d+)?\)$/.test(text)) text = "-" + text.slice(1, -1);
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) return null;
  const amount = Number(text);
  return Number.isFinite(amount) ? amount : null;
}
const normalizedName = (name: string) => name.replace(/\s+/g, "").replace(/（/g, "(").replace(/）/g, ")");
function amountOf(row: Row, income: boolean, report: Report) {
  if (!income || report === "annual") return parseDartAmount(row.thstrm_amount);
  // Half/Q3 thstrm_amount is a standalone 3-month amount. Never mix it
  // with year-to-date values when a cumulative amount is missing.
  return parseDartAmount(row.thstrm_add_amount) ?? (report === "q1" ? parseDartAmount(row.thstrm_amount) : null);
}
function matchAccount(rows: Row[], key: AmountKey, report: Report): Row | undefined {
  const rule = ACCOUNTS[key];
  const income = rule.statement === "income";
  const candidates = rows.filter(row => income ? row.sj_div === "IS" || row.sj_div === "CIS" : row.sj_div === "BS")
    .sort((a, b) => Number(a.sj_div === "CIS") - Number(b.sj_div === "CIS"));
  // IDs across both income statement types take precedence over name aliases.
  for (const id of rule.ids) {
    const matches = candidates.filter(row => row.account_id === id);
    if (matches.length) return matches.find(row => amountOf(row, income, report) !== null) ?? matches[0];
  }
  for (const name of rule.names) {
    const matches = candidates.filter(row => typeof row.account_nm === "string" && normalizedName(row.account_nm) === normalizedName(name));
    if (matches.length) return matches.find(row => amountOf(row, income, report) !== null) ?? matches[0];
  }
}
function ratio(numerator: number | null, denominator: number | null) {
  if (numerator === null || denominator === null || denominator === 0) return null;
  const value = numerator / denominator * 100;
  return Number.isFinite(value) ? value : null;
}
export function normalizeFinancials(rows: Row[], report: Report): { financials: Financials; currency: string | null } {
  const amounts = {} as Record<AmountKey, number | null>;
  const currencies = new Set<string>();
  for (const key of Object.keys(ACCOUNTS) as AmountKey[]) {
    const row = matchAccount(rows, key, report);
    amounts[key] = row ? amountOf(row, ACCOUNTS[key].statement === "income", report) : null;
    if (row && amounts[key] !== null && typeof row.currency === "string" && row.currency) currencies.add(row.currency);
  }
  if (currencies.size > 1) throw new DartError("DART_CURRENCY_MISMATCH", "동일 재무제표의 계정 통화가 일치하지 않습니다.");
  return {
    currency: [...currencies][0] ?? null,
    financials: {
      ...amounts,
      operatingMargin: ratio(amounts.operatingIncome, amounts.revenue),
      debtRatio: ratio(amounts.totalLiabilities, amounts.totalEquity),
    },
  };
}

async function fetchStatement(apiKey: string, corpCode: string, year: string, report: Report, fsDiv: FsDiv): Promise<Row[] | null> {
  const buffer = await requestDart(apiKey, "fnlttSinglAcntAll.json", {
    corp_code: corpCode, bsns_year: year, reprt_code: REPORT_CODES[report], fs_div: fsDiv,
  });
  let body: { status?: unknown; list?: unknown };
  try { body = JSON.parse(buffer.toString("utf8")); }
  catch { throw new DartError("DART_JSON_INVALID", "DART 재무제표 응답을 JSON으로 해석할 수 없습니다."); }
  if (!body || typeof body !== "object" || typeof body.status !== "string") {
    throw new DartError("DART_RESPONSE_INVALID", "DART 재무제표 응답 상태가 올바르지 않습니다.");
  }
  if (body.status === "013") return null;
  checkDartStatus({ result: body });
  if (!Array.isArray(body.list)) throw new DartError("DART_RESPONSE_INVALID", "DART 재무제표 목록 형식이 올바르지 않습니다.");
  if (!body.list.length) return null;
  const rows: Row[] = [];
  for (const raw of body.list) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
        raw.corp_code !== corpCode || raw.bsns_year !== year || raw.reprt_code !== REPORT_CODES[report]) {
      throw new DartError("DART_RECORD_INVALID", "DART 재무제표의 기업·연도·보고서 정보가 요청과 일치하지 않습니다.");
    }
    rows.push(raw);
  }
  return rows;
}

const TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map<string, { data: FinancialResponse; expiresAt: number }>();
const pending = new Map<string, Promise<FinancialResponse>>();
export async function getFinancials(stockCode: string, year: string, report: Report, apiKey: string): Promise<FinancialResponse> {
  const key = [stockCode, year, report].join(":");
  const cached = cache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.data;
  if (pending.has(key)) return pending.get(key)!;
  const task = (async () => {
    const corp = await getCorpInfo(stockCode, apiKey);
    if (!corp) throw new DartError("CORP_NOT_FOUND", "해당 종목코드를 DART 기업 목록에서 찾을 수 없습니다.", 404);
    let fsDiv: FsDiv = "CFS";
    let rows = await fetchStatement(apiKey, corp.corpCode, year, report, fsDiv);
    // Only no-data responses trigger fallback. Auth/network errors must surface.
    if (rows === null) {
      fsDiv = "OFS";
      rows = await fetchStatement(apiKey, corp.corpCode, year, report, fsDiv);
    }
    if (rows === null) throw new DartError("FINANCIALS_NOT_FOUND", "해당 사업연도·보고서의 연결 및 별도 재무제표 공시가 없습니다.", 404, "013");
    const data: FinancialResponse = {
      stockCode, corpCode: corp.corpCode, corpName: corp.corpName,
      businessYear: year, report, fsDiv,
      incomePeriod: report === "annual" ? "annual" : "yearToDate",
      ...normalizeFinancials(rows, report),
    };
    for (const [oldKey, entry] of cache) if (entry.expiresAt <= Date.now()) cache.delete(oldKey);
    if (cache.size >= 256) cache.delete(cache.keys().next().value!);
    cache.set(key, { data, expiresAt: Date.now() + TTL_MS });
    return data;
  })();
  pending.set(key, task);
  try { return await task; }
  finally { pending.delete(key); }
}
