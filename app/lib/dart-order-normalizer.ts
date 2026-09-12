import "server-only";
import type { getDartOrders } from "./dart-orders";
import type { OrderSection, RawOrderTable } from "./dart-order-parser";

type RawOrders = Awaited<ReturnType<typeof getDartOrders>>;
type Candidate = { section: OrderSection; table: RawOrderTable; tableIndex: number };
type GridCell = { text: string; row: number; column: number };
export type NormalizedOrderBacklog = {
  stockCode: string; corpName: string; reportName: string | null; reportDate: string | null; rceptNo: string | null;
  scope: string; businessSegment: string | null;
  backlogRaw: string | null; backlogValue: number | null; currency: string | null; unit: string | null;
  backlogKRW: number | null; beginningBacklog: number | null; newOrders: number | null;
  recognizedRevenue: number | null; endingBacklog: number | null;
  domesticBacklog: number | null; overseasBacklog: number | null; totalBacklog: number | null;
  normalizationStatus: "normalized" | "partially_normalized" | "raw_only";
  notes: string[];
  provenance: {
    source: "OpenDART"; reportName: string | null; reportDate: string | null; rceptNo: string | null;
    sourceUrl: string | null; scope: string; rawUnit: string | null; valueBasis: string;
    sectionTitle: string | null; sourceFile: string | null; sourcePath: string | null; tableIndex: number | null;
    rawTable: RawOrderTable | null; expandedRow: string[] | null; sourceRow: number | null;
    fieldColumns: Record<string, string | null>;
  };
};
const compact = (s: string) => s.replace(/\s+/g, "");
export function parseOrderNumber(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  let value = raw.trim().replace(/\s+/g, "");
  if (!value || /^[-–—]+$/.test(value)) return null;
  if (/^\(.*\)$/.test(value)) value = "-" + value.slice(1, -1);
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(value)) return null;
  const number = Number(value.replace(/,/g, ""));
  return Number.isFinite(number) && Math.abs(number) <= Number.MAX_SAFE_INTEGER ? number : null;
}
// Expand merged cells without summing duplicated values. Keep each cell's physical origin.
export function expandOrderCells(table: RawOrderTable): GridCell[][] {
  const grid: GridCell[][] = [];
  table.cells.forEach((row, r) => {
    grid[r] ??= [];
    let col = 0;
    row.forEach((cell, c) => {
      while (grid[r][col] !== undefined) col++;
      for (let dr = 0; dr < cell.rowSpan; dr++) {
        grid[r + dr] ??= [];
        for (let dc = 0; dc < cell.colSpan; dc++) grid[r + dr][col + dc] = { text: cell.text, row: r, column: c };
      }
      col += cell.colSpan;
    });
  });
  return grid.slice(table.headerRows.length, table.cells.length);
}
function candidates(raw: RawOrders): Candidate[] {
  return raw.orderSections.filter(s => /매출.*수주/.test(compact(s.sectionTitle)))
    .flatMap(section => section.tables.map((table, tableIndex) => ({ section, table, tableIndex })));
}
function column(c: Candidate, pattern: RegExp) {
  const matches = c.table.columns.map((label, index) => ({ label: compact(label), index }))
    .filter(x => pattern.test(x.label) && !x.label.includes("수량"));
  return matches.length === 1 ? matches[0].index : -1;
}
function unitOf(c: Candidate) {
  const rawUnit = [...c.table.contextBefore.matchAll(/단위\s*[:：]\s*([^)\n]+)/g)].at(-1)?.[1].trim() ?? null;
  const units = rawUnit?.match(/천USD|USD|억원|백만원|천원|원/g) ?? [];
  const unit = units.length === 1 ? units[0] : null;
  return { rawUnit, unit, currency: unit?.includes("USD") ? "USD" : unit ? "KRW" : null };
}
type Fields = { backlog: RegExp; beginning?: RegExp; orders?: RegExp; revenue?: RegExp };
function make(raw: RawOrders, c: Candidate, row: GridCell[], scope: string, segment: string | null, fields: Fields, notes: string[]): NormalizedOrderBacklog {
  const { unit, currency, rawUnit } = unitOf(c);
  const indexes = {
    backlog: column(c, fields.backlog), beginningBacklog: fields.beginning ? column(c, fields.beginning) : -1,
    newOrders: fields.orders ? column(c, fields.orders) : -1, recognizedRevenue: fields.revenue ? column(c, fields.revenue) : -1,
  };
  const read = (index: number) => parseOrderNumber(row[index]?.text);
  const backlogRaw = row[indexes.backlog]?.text ?? null;
  const backlogValue = read(indexes.backlog);
  const factor: Record<string, number> = { "원": 1, "천원": 1000, "백만원": 1000000, "억원": 100000000 };
  const converted = backlogValue !== null && unit && factor[unit] ? backlogValue * factor[unit] : null;
  const backlogKRW = converted !== null && Number.isSafeInteger(converted) ? converted : null;
  const normalizationStatus = backlogValue === null ? "raw_only" : backlogKRW === null ? "partially_normalized" : "normalized";
  return {
    stockCode: raw.stockCode, corpName: raw.corpName, reportName: raw.report?.reportName ?? null,
    reportDate: raw.report?.reportDate ?? null, rceptNo: raw.report?.rceptNo ?? null, scope, businessSegment: segment,
    backlogRaw, backlogValue, currency, unit, backlogKRW,
    beginningBacklog: read(indexes.beginningBacklog), newOrders: read(indexes.newOrders), recognizedRevenue: read(indexes.recognizedRevenue),
    endingBacklog: backlogValue, domesticBacklog: null, overseasBacklog: null, totalBacklog: backlogValue,
    normalizationStatus,
    notes: [...notes, ...(!unit ? ["단위를 확정하지 못해 원화 변환하지 않았습니다."] : []),
      ...(currency === "USD" ? ["환율을 적용하지 않았습니다. backlogKRW는 null입니다."] : []),
      "backlogKRW 외 숫자는 원문 unit 기준입니다. normalized는 집계범위의 동일성을 의미하지 않습니다."],
    provenance: {
      source: "OpenDART", reportName: raw.report?.reportName ?? null, reportDate: raw.report?.reportDate ?? null,
      rceptNo: raw.report?.rceptNo ?? null, sourceUrl: raw.report?.sourceUrl ?? null, scope, rawUnit,
      valueBasis: "backlogKRW만 원 단위; 그 외 금액은 원문 unit. 원문 행/열에서 직접 추출하며 차감 추정 없음.",
      sectionTitle: c.section.title, sourceFile: c.section.sourceFile, sourcePath: c.section.sourcePath,
      tableIndex: c.tableIndex, rawTable: c.table, expandedRow: row.map(cell => cell.text),
      sourceRow: row[indexes.backlog]?.row ?? null,
      fieldColumns: Object.fromEntries(Object.entries(indexes).map(([key, index]) => [key, c.table.columns[index] ?? null])),
    },
  };
}
function unique<T>(items: T[]): T | null { return items.length === 1 ? items[0] : null; }
function rows(c: Candidate) { return expandOrderCells(c.table); }

export function normalizeIljinElectric(raw: RawOrders): NormalizedOrderBacklog[] {
  const c = unique(candidates(raw).filter(c => column(c, /^수주잔고$/) >= 0 && column(c, /^구분$/) >= 0 && column(c, /^품목$/) >= 0));
  if (!c) return [];
  const category = column(c, /^품목$/), division = column(c, /^구분$/), backlog = column(c, /^수주잔고$/);
  const totals = rows(c).filter(r => compact(r[category]?.text ?? "") === "합계");
  const row = unique(totals.filter(r => compact(r[division]?.text ?? "") === "계"));
  if (!row) return [];
  const result = make(raw, c, row, "전력선 등 및 변압기 등 중전기 국내·해외 합계", null,
    { backlog: /^수주잔고$/, revenue: /^기납품액$/ }, ["수주총액은 신규수주가 아니므로 newOrders에 사용하지 않습니다."]);
  const domestic = unique(totals.filter(r => compact(r[division]?.text ?? "") === "국내"));
  const overseas = unique(totals.filter(r => compact(r[division]?.text ?? "") === "해외"));
  result.domesticBacklog = parseOrderNumber(domestic?.[backlog]?.text);
  result.overseasBacklog = parseOrderNumber(overseas?.[backlog]?.text);
  return [result];
}
export function normalizeLsElectric(raw: RawOrders): NormalizedOrderBacklog[] {
  const output: NormalizedOrderBacklog[] = [];
  for (const c of candidates(raw).filter(c => column(c, /^수주잔고\/금액$/) >= 0 && column(c, /^이월수주잔액\/금액$/) >= 0)) {
    const scope = [...c.table.contextBefore.matchAll(/\[([^\]\n]+)\]/g)].at(-1)?.[1].trim();
    if (!scope || !/^LS(?:\s|[가-힣])/.test(scope)) continue;
    const body = rows(c);
    const row = unique(body.filter(r => r.slice(0, 4).some(cell => compact(cell.text) === "합계"))) ?? (body.length === 1 ? body[0] : null);
    if (!row) continue;
    output.push(make(raw, c, row, scope, null,
      { backlog: /^수주잔고\/금액$/, beginning: /^이월수주잔액\/금액$/, orders: /^당기수주금액\/금액$/, revenue: /^기납품액\/금액$/ },
      ["각 회사 표를 독립적으로 유지하며 본체와 계열사를 합산하지 않습니다.", "수주총액 열은 신규수주로 간주하지 않습니다."]));
  }
  return output;
}
export function normalizeHdHyundaiElectric(raw: RawOrders): NormalizedOrderBacklog[] {
  const c = unique(candidates(raw).filter(c => /HD현대일렉트릭.*종속회사/.test(c.table.contextBefore) && column(c, /^수주잔고(?:\/금액)?$/) >= 0));
  if (!c) return [];
  const category = column(c, /^구분$/);
  const row = unique(rows(c).filter(r => compact(r[category]?.text ?? "") === "전기전자부문"));
  return row ? [make(raw, c, row, "회사 및 종속회사", "전기전자부문",
    { backlog: /^수주잔고(?:\/금액)?$/, revenue: /^기납품액(?:\/금액)?$/ },
    ["회사·종속회사 합산 표이며 개별 회사 금액은 제시되지 않아 분리하지 않습니다.", "수주총액에서 신규수주를 추정하지 않습니다."])] : [];
}
export function normalizeHyosungHeavyIndustries(raw: RawOrders): NormalizedOrderBacklog[] {
  const c = unique(candidates(raw).filter(c => column(c, /^당기말수주잔/) >= 0 && column(c, /^사업부문$/) >= 0));
  if (!c) return [];
  const category = column(c, /^사업부문$/), backlog = column(c, /^당기말수주잔/);
  const heavy = rows(c).filter(r => compact(r[category]?.text ?? "") === "중공업");
  // One merged value spans multiple company rows: count the physical source cell once.
  const origins = new Set(heavy.map(r => r[backlog]?.row));
  if (!heavy.length || origins.size !== 1) return [];
  return [make(raw, c, heavy[0], "중공업 부문", "중공업",
    { backlog: /^당기말수주잔/, beginning: /^전기말수주잔/, orders: /^당기수주액/, revenue: /^당기매출액/ },
    ["중공업 부문 지배회사 및 주요종속회사 범위입니다. 건설 부문은 제외했습니다.", "회사별 병합 셀의 같은 잔액을 중복 합산하지 않았습니다.", "보고서에 기재된 환산금액을 그대로 사용했습니다."])];
}
function unavailable(raw: RawOrders): NormalizedOrderBacklog {
  return {
    stockCode: raw.stockCode, corpName: raw.corpName, reportName: raw.report?.reportName ?? null,
    reportDate: raw.report?.reportDate ?? null, rceptNo: raw.report?.rceptNo ?? null,
    scope: "확인 불가", businessSegment: null, backlogRaw: null, backlogValue: null, currency: null, unit: null,
    backlogKRW: null, beginningBacklog: null, newOrders: null, recognizedRevenue: null, endingBacklog: null,
    domesticBacklog: null, overseasBacklog: null, totalBacklog: null, normalizationStatus: "raw_only",
    notes: ["지원 대상 또는 표 구조·집계범위를 확정하지 못했습니다. raw API 원문을 확인하세요."],
    provenance: { source: "OpenDART", reportName: raw.report?.reportName ?? null, reportDate: raw.report?.reportDate ?? null,
      rceptNo: raw.report?.rceptNo ?? null, sourceUrl: raw.report?.sourceUrl ?? null, scope: "확인 불가", rawUnit: null,
      valueBasis: "정규화하지 않음", sectionTitle: null, sourceFile: null, sourcePath: null, tableIndex: null,
      rawTable: null, expandedRow: null, sourceRow: null, fieldColumns: {} },
  };
}
export function normalizeDartOrders(raw: RawOrders) {
  const adapters: Record<string, (raw: RawOrders) => NormalizedOrderBacklog[]> = {
    "103590": normalizeIljinElectric, "010120": normalizeLsElectric,
    "267260": normalizeHdHyundaiElectric, "298040": normalizeHyosungHeavyIndustries,
  };
  const normalized = adapters[raw.stockCode]?.(raw) ?? [];
  const main = raw.stockCode === "010120" ? unique(normalized.filter(row => row.scope === "LS ELECTRIC")) : unique(normalized);
  return {
    source: "OpenDART", stockCode: raw.stockCode, corpName: raw.corpName, report: raw.report,
    primary: main ?? unavailable(raw),
    subsidiaries: raw.stockCode === "010120" ? normalized.filter(row => row.scope !== "LS ELECTRIC") : [],
    warnings: raw.warnings, rawApiUrl: "/api/dart/orders?stockCode=" + raw.stockCode,
  };
}
