import { get } from "node:https";
import JSZip from "jszip";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import "server-only";


export type CorpInfo = {
  stockCode: string;
  corpCode: string;
  corpName: string;
  modifyDate: string;
};

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;
let cache: { byStockCode: Map<string, CorpInfo>; expiresAt: number } | undefined;
let pending: Promise<Map<string, CorpInfo>> | undefined;

export class DartError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 502,
    readonly dartStatus?: string,
    readonly upstreamStatus?: number,
  ) {
    super(message);
  }
}

// Static descriptions only: upstream text and exception messages may contain
// request URLs or credentials and must never reach responses or logs.
const DART_ERRORS: Record<string, { message: string; status: number }> = {
  "010": { message: "DART에 등록되지 않은 API 키입니다.", status: 502 },
  "011": { message: "사용이 중지된 DART API 키입니다.", status: 502 },
  "012": { message: "DART API에서 서버 IP 접근을 허용하지 않습니다.", status: 502 },
  "013": { message: "DART에서 고유번호 목록 데이터를 제공하지 않았습니다.", status: 502 },
  "014": { message: "DART 고유번호 목록 파일이 존재하지 않습니다.", status: 502 },
  "020": { message: "DART API 요청 한도를 초과했습니다.", status: 429 },
  "021": { message: "DART API 조회 가능 회사 수를 초과했습니다.", status: 502 },
  "100": { message: "DART API가 요청 필드 값을 거부했습니다.", status: 502 },
  "101": { message: "DART API가 부적절한 접근으로 요청을 거부했습니다.", status: 502 },
  "800": { message: "DART API가 시스템 점검 중입니다.", status: 503 },
  "900": { message: "DART API 내부 오류가 발생했습니다.", status: 502 },
  "901": { message: "DART API 키의 개인정보 보유기간이 만료되었습니다.", status: 502 },
};

export function requestDart(apiKey: string, endpoint: "corpCode.xml" | "fnlttSinglAcntAll.json", params: Record<string, string> = {}): Promise<Buffer> {
  // Native HTTPS avoids Next.js fetch URL logging (the DART key is a query parameter).
  const url = new URL(endpoint, "https://opendart.fss.or.kr/api/");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set("crtfc_key", apiKey);
  const signal = AbortSignal.timeout(40_000);
  return new Promise((resolve, reject) => {
    const request = get(url, { signal, headers: { "User-Agent": "PeerResearchTool/1.0", Accept: "*/*" } }, (response) => {
      const status = response.statusCode ?? 502;
      if (status !== 200) {
        response.resume();
        reject(new DartError(
          "DART_HTTP_ERROR",
          "DART 서버가 HTTP 오류를 반환했습니다.",
          status === 429 ? 429 : status === 503 ? 503 : 502,
          undefined, status,
        ));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_DOWNLOAD_BYTES) {
          reject(new DartError("DART_RESPONSE_TOO_LARGE", "DART 응답 크기가 허용 범위를 초과했습니다."));
          response.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks)));
      response.on("error", () => reject(new DartError(
        signal.aborted ? "DART_TIMEOUT" : "DART_NETWORK_ERROR",
        signal.aborted ? "DART API 응답 시간이 초과되었습니다." : "DART 데이터 수신 연결이 중단되었습니다.",
        signal.aborted ? 504 : 502,
      )));
    });
    request.on("error", () => reject(new DartError(
      signal.aborted ? "DART_TIMEOUT" : "DART_NETWORK_ERROR",
      signal.aborted ? "DART API 응답 시간이 초과되었습니다." : "DART API에 연결할 수 없습니다. 서버 네트워크 또는 TLS 연결을 확인해주세요.",
      signal.aborted ? 504 : 502,
    )));
  });
}

function parseXml(xml: string): Record<string, unknown> {
  // Preserve leading zeros in stock/corp codes and dates. No DTDs needed.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) {
    throw new DartError("DART_XML_INVALID", "DART 응답 XML이 올바르지 않습니다.");
  }
  try {
    return new XMLParser({ parseTagValue: false, trimValues: true }).parse(xml);
  } catch {
    throw new DartError("DART_XML_INVALID", "DART 응답 XML을 해석할 수 없습니다.");
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function checkDartStatus(document: Record<string, unknown>) {
  const result = object(document.result);
  if (typeof result?.status !== "string" || result.status === "000") return;
  const status = /^\d{3}$/.test(result.status) ? result.status : undefined;
  const detail = status ? DART_ERRORS[status] : undefined;
  throw new DartError("DART_API_ERROR", detail?.message ?? "DART API가 알 수 없는 오류 상태를 반환했습니다.", detail?.status ?? 502, status);
}

async function loadList(apiKey: string): Promise<Map<string, CorpInfo>> {
  const buffer = await requestDart(apiKey, "corpCode.xml");
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) {
    // Authentication/rate-limit errors arrive as XML rather than ZIP.
    checkDartStatus(parseXml(buffer.toString("utf8")));
    throw new DartError("DART_ZIP_EXPECTED", "DART API가 ZIP 파일 대신 다른 응답을 반환했습니다.");
  }
  let xml: string;
  try {
    const archive = await JSZip.loadAsync(buffer, { checkCRC32: true });
    const file = Object.values(archive.files).find(entry => !entry.dir && /(^|\/)CORPCODE\.xml$/i.test(entry.name));
    if (!file) throw new DartError("DART_XML_MISSING", "DART ZIP 안에 CORPCODE.xml 파일이 없습니다.");
    xml = await file.async("string");
  } catch (error) {
    if (error instanceof DartError) throw error;
    throw new DartError("DART_ZIP_INVALID", "DART ZIP 파일의 압축을 해제할 수 없습니다.");
  }
  const document = parseXml(xml);
  checkDartStatus(document);
  const rawList = object(document.result)?.list;
  const rows = Array.isArray(rawList) ? rawList : rawList ? [rawList] : [];
  const byStockCode = new Map<string, CorpInfo>();
  for (const row of rows) {
    const item = object(row);
    if (!item || typeof item.stock_code !== "string" || !/^\d{6}$/.test(item.stock_code)) continue;
    if (typeof item.corp_code !== "string" || !/^\d{8}$/.test(item.corp_code) ||
        typeof item.corp_name !== "string" || !item.corp_name ||
        typeof item.modify_date !== "string" || !/^\d{8}$/.test(item.modify_date)) {
      throw new DartError("DART_RECORD_INVALID", "DART 기업 정보의 필수 필드 형식이 올바르지 않습니다.");
    }
    byStockCode.set(item.stock_code, {
      stockCode: item.stock_code, corpCode: item.corp_code,
      corpName: item.corp_name, modifyDate: item.modify_date,
    });
  }
  if (!byStockCode.size) throw new DartError("DART_LIST_EMPTY", "DART 목록에 유효한 상장사 종목코드가 없습니다.");
  return byStockCode;
}

async function getList(apiKey: string) {
  if (cache && Date.now() < cache.expiresAt) return cache.byStockCode;
  // Concurrent requests share one download; failures are never cached.
  if (!pending) {
    pending = loadList(apiKey).then(byStockCode => {
      cache = { byStockCode, expiresAt: Date.now() + TTL_MS };
      return byStockCode;
    }).finally(() => { pending = undefined; });
  }
  return pending;
}


export async function getCorpInfo(stockCode: string, apiKey: string) {
  return (await getList(apiKey)).get(stockCode);
}
