import { NextRequest, NextResponse } from "next/server";
import { DartError } from "@/app/lib/dart";
import { getFinancials, REPORT_CODES, type Report } from "@/app/lib/dart-financials";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const stockCode = params.get("stockCode");
  const year = params.get("year");
  const report = params.get("report");
  const headers = { "Cache-Control": "no-store" };
  if (!stockCode || !/^\d{6}$/.test(stockCode)) {
    return NextResponse.json({ code: "INVALID_STOCK_CODE", error: "stockCode는 정확히 숫자 6자리여야 합니다." }, { status: 400, headers });
  }
  if (!year || !/^\d{4}$/.test(year) || Number(year) < 2015 || Number(year) > new Date().getFullYear()) {
    return NextResponse.json({ code: "INVALID_YEAR", error: "year는 2015년부터 현재 연도까지의 숫자 4자리여야 합니다." }, { status: 400, headers });
  }
  if (!report || !Object.hasOwn(REPORT_CODES, report)) {
    return NextResponse.json({ code: "INVALID_REPORT", error: "report는 annual, q1, half, q3 중 하나여야 합니다." }, { status: 400, headers });
  }
  const apiKey = process.env.DART_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json({ code: "DART_KEY_MISSING", error: "서버 환경변수 DART_API_KEY가 설정되지 않았습니다." }, { status: 500, headers });
  }
  try {
    return NextResponse.json(await getFinancials(stockCode, year, report as Report, apiKey), { headers });
  } catch (error) {
    const safe = error instanceof DartError ? error : new DartError("DART_INTERNAL_ERROR", "DART 재무제표 처리 중 내부 오류가 발생했습니다.", 500);
    return NextResponse.json({
      code: safe.code, error: safe.message,
      ...(safe.dartStatus ? { dartStatus: safe.dartStatus } : {}),
      ...(safe.upstreamStatus ? { upstreamStatus: safe.upstreamStatus } : {}),
    }, { status: safe.status, headers });
  }
}
