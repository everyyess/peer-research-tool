import "server-only";
import { checkDartStatus, DartError, requestDart } from "./dart";

export type DartReport = {
  rceptNo: string; reportName: string; reportDate: string; corpCode: string;
  reportType: "annual" | "half" | "quarter"; sourceUrl: string;
};
const kinds = { 사업보고서: "annual", 반기보고서: "half", 분기보고서: "quarter" } as const;
const priority = { annual: 0, half: 1, quarter: 2 };
export function selectLatestReport(records: unknown[], corpCode: string): DartReport | null {
  const reports: DartReport[] = [];
  for (const item of records) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (row.corp_code !== corpCode || typeof row.report_nm !== "string" ||
        typeof row.rcept_no !== "string" || !/^\d{14}$/.test(row.rcept_no) ||
        typeof row.rcept_dt !== "string" || !/^\d{8}$/.test(row.rcept_dt)) continue;
    const match = /^(?:\[[^\]]+\]\s*)*(사업보고서|반기보고서|분기보고서)\s*(?:\(|$)/.exec(row.report_nm);
    if (!match) continue;
    reports.push({
      rceptNo: row.rcept_no, reportName: row.report_nm, reportDate: row.rcept_dt, corpCode,
      reportType: kinds[match[1] as keyof typeof kinds],
      sourceUrl: "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=" + row.rcept_no,
    });
  }
  // Newest receipt date first; report-type priority only breaks same-date ties.
  return reports.sort((a, b) => b.reportDate.localeCompare(a.reportDate) ||
    priority[a.reportType] - priority[b.reportType] || b.rceptNo.localeCompare(a.rceptNo))[0] ?? null;
}
export async function findLatestPeriodicReport(corpCode: string, apiKey: string): Promise<DartReport | null> {
  const end = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()).replace(/-/g, "");
  const records: unknown[] = [];
  for (let page = 1; page <= 100; page++) {
    const buffer = await requestDart(apiKey, "list.json", {
      corp_code: corpCode, bgn_de: "19990101", end_de: end, pblntf_ty: "A",
      last_reprt_at: "Y", sort: "date", sort_mth: "desc", page_count: "100", page_no: String(page),
    });
    let body;
    try { body = JSON.parse(buffer.toString("utf8")); }
    catch { throw new DartError("DART_JSON_INVALID", "DART 공시검색 응답을 해석할 수 없습니다."); }
    if (!body || typeof body.status !== "string") throw new DartError("DART_RESPONSE_INVALID", "공시검색 응답 상태가 없습니다.");
    if (body.status === "013") return selectLatestReport(records, corpCode);
    checkDartStatus({ result: body });
    if (!Array.isArray(body.list)) throw new DartError("DART_RESPONSE_INVALID", "공시검색 목록 형식이 잘못되었습니다.");
    records.push(...body.list);
    const latest = selectLatestReport(records, corpCode);
    const lastDate = body.list.at(-1)?.rcept_dt;
    if (page >= Number(body.total_page) || !body.list.length ||
        (latest && typeof lastDate === "string" && lastDate < latest.reportDate)) return latest;
  }
  throw new DartError("DART_SEARCH_LIMIT", "정기보고서 검색 페이지 한도를 초과했습니다.");
}
