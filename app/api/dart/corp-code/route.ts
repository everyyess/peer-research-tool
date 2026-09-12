import { NextRequest, NextResponse } from "next/server";
import { DartError, getCorpInfo } from "@/app/lib/dart";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const stockCode = request.nextUrl.searchParams.get("stockCode");
  const headers = { "Cache-Control": "no-store" };
  if (!stockCode || !/^\d{6}$/.test(stockCode)) {
    return NextResponse.json({ code: "INVALID_STOCK_CODE", error: "stockCode는 정확히 숫자 6자리여야 합니다." }, { status: 400, headers });
  }
  const apiKey = process.env.DART_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json({ code: "DART_KEY_MISSING", error: "서버 환경변수 DART_API_KEY가 설정되지 않았습니다." }, { status: 500, headers });
  }
  try {
    const corp = await getCorpInfo(stockCode, apiKey);
    if (!corp) return NextResponse.json({ code: "CORP_NOT_FOUND", error: "해당 종목코드를 DART 기업 목록에서 찾을 수 없습니다.", stockCode }, { status: 404, headers });
    return NextResponse.json(corp, { headers });
  } catch (error) {
    const safe = error instanceof DartError ? error : new DartError("DART_INTERNAL_ERROR", "DART 기업 정보 처리 중 내부 오류가 발생했습니다.", 500);
    return NextResponse.json({
      code: safe.code, error: safe.message,
      ...(safe.dartStatus ? { dartStatus: safe.dartStatus } : {}),
      ...(safe.upstreamStatus ? { upstreamStatus: safe.upstreamStatus } : {}),
    }, { status: safe.status, headers });
  }
}
