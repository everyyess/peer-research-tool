import { NextRequest, NextResponse } from "next/server";
import { DartError } from "@/app/lib/dart";
import { getDartOrders } from "@/app/lib/dart-orders";

export const runtime = "nodejs";
export const maxDuration = 180;

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
  try { return NextResponse.json(await getDartOrders(stockCode, apiKey), { headers }); }
  catch (error) {
    const safe = error instanceof DartError ? error : new DartError("DART_INTERNAL_ERROR", "수주 원문 조회 중 내부 오류가 발생했습니다.", 500);
    return NextResponse.json({
      code: safe.code, error: safe.message,
      ...(safe.dartStatus ? { dartStatus: safe.dartStatus } : {}),
      ...(safe.upstreamStatus ? { upstreamStatus: safe.upstreamStatus } : {}),
    }, { status: safe.status, headers });
  }
}
