import "server-only";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { checkDartStatus, DartError, getCorpInfo, requestDart } from "./dart";
import { findLatestPeriodicReport } from "./dart-reports";
import { extractOrderSections, ORDER_KEYWORDS, type OrderSection } from "./dart-order-parser";

async function readOrders(stockCode: string, apiKey: string) {
  const corp = await getCorpInfo(stockCode, apiKey);
  if (!corp) throw new DartError("CORP_NOT_FOUND", "해당 종목코드를 DART 기업 목록에서 찾을 수 없습니다.", 404);
  const report = await findLatestPeriodicReport(corp.corpCode, apiKey);
  if (!report) return {
    stockCode, corpCode: corp.corpCode, corpName: corp.corpName, report: null,
    orderSections: [] as OrderSection[], searchedKeywords: [...ORDER_KEYWORDS],
    scannedFiles: [] as string[], warnings: ["정기보고서를 찾지 못했습니다."],
  };
  const buffer = await requestDart(apiKey, "document.xml", { rcept_no: report.rceptNo });
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) {
    try {
      const body = new XMLParser({ parseTagValue: false }).parse(buffer.toString("utf8"));
      checkDartStatus(body);
    } catch (error) {
      if (error instanceof DartError) throw error;
    }
    throw new DartError("DART_ZIP_EXPECTED", "DART 원문 API가 ZIP 파일을 반환하지 않았습니다.");
  }
  let zip;
  try { zip = await JSZip.loadAsync(buffer, { checkCRC32: true }); }
  catch { throw new DartError("DART_ZIP_INVALID", "DART 원문 ZIP 압축을 해제할 수 없습니다."); }
  const files = Object.values(zip.files).filter(file => !file.dir && /\.(xml|html?)$/i.test(file.name));
  if (!files.length) throw new DartError("DART_DOCUMENT_MISSING", "DART ZIP에 XML/HTML 원문이 없습니다.");
  const scannedFiles: string[] = [];
  const orderSections: OrderSection[] = [];
  const warnings: string[] = [];
  let total = 0;
  for (const file of files) {
    try {
      const raw = await file.async("nodebuffer");
      total += raw.length;
      if (total > 64 * 1024 * 1024) throw new DartError("DART_DOCUMENT_TOO_LARGE", "DART 원문이 처리 가능한 크기를 초과했습니다.");
      const declared = /encoding\s*=\s*["']([^"']+)/i.exec(raw.toString("ascii", 0, 300))?.[1];
      const encoding = declared && /euc-kr|ks_c_5601|cp949/i.test(declared) ? "euc-kr" : "utf-8";
      const xml = new TextDecoder(encoding, { fatal: true }).decode(raw);
      orderSections.push(...extractOrderSections(xml, file.name));
      scannedFiles.push(file.name);
    } catch (error) {
      if (error instanceof DartError && error.code === "DART_DOCUMENT_TOO_LARGE") throw error;
      // No raw exception text: it may include sensitive network details.
      warnings.push("원문 파일 하나를 해석하지 못했습니다: " + file.name);
    }
  }
  if (!scannedFiles.length) throw new DartError("DART_DOCUMENT_INVALID", "다운로드한 DART 원문을 해석할 수 없습니다.");
  return {
    stockCode, corpCode: corp.corpCode, corpName: corp.corpName, report,
    orderSections, searchedKeywords: [...ORDER_KEYWORDS], scannedFiles, warnings,
  };
}
type OrdersResult = Awaited<ReturnType<typeof readOrders>>;
const cache = new Map<string, { data: OrdersResult; expiresAt: number }>();
const pending = new Map<string, Promise<OrdersResult>>();
export async function getDartOrders(stockCode: string, apiKey: string) {
  const entry = cache.get(stockCode);
  if (entry && entry.expiresAt > Date.now()) return entry.data;
  if (pending.has(stockCode)) return pending.get(stockCode)!;
  const task = readOrders(stockCode, apiKey).then(data => {
    // Partial document failures should be retryable.
    if (!data.warnings.length) {
      for (const [key, entry] of cache) if (entry.expiresAt <= Date.now()) cache.delete(key);
      if (cache.size >= 32) cache.delete(cache.keys().next().value!);
      cache.set(stockCode, { data, expiresAt: Date.now() + 6 * 60 * 60 * 1000 });
    }
    return data;
  });
  pending.set(stockCode, task);
  try { return await task; } finally { pending.delete(stockCode); }
}
