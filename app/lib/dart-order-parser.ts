import "server-only";
import { XMLParser } from "fast-xml-parser";
import { DartError } from "./dart";

export const ORDER_KEYWORDS = ["수주상황", "수주현황", "수주잔고", "수주총액", "계약잔액", "order backlog", "orders", "수주"] as const;
type Element = { tag: string; attrs: Record<string, string>; children: Array<Element | string> };
type Block = { node: Element; text: string; title: string; subtitle: string; path: string };
export type RawCell = { text: string; rowSpan: number; colSpan: number; tag: string };
export type RawOrderTable = {
  columns: string[]; headerRows: string[][]; headerSource: "explicit" | "inferred" | "none";
  rows: string[][]; cells: RawCell[][]; contextBefore: string; contextAfter: string;
};
export type OrderSection = {
  title: string; sectionTitle: string; text: string; matchedKeywords: string[];
  sourceFile: string; sourcePath: string; tables: RawOrderTable[];
};
const compact = (value: string) => value.replace(/\s+/g, "").toLowerCase();
function keywords(text: string) {
  const value = compact(text);
  return ORDER_KEYWORDS.filter(keyword => value.includes(compact(keyword)));
}
function elements(records: unknown[]): Array<Element | string> {
  const result: Array<Element | string> = [];
  for (const raw of records) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    if ("#text" in record) { result.push(String(record["#text"])); continue; }
    const tag = Object.keys(record).find(key => key !== ":@" && !key.startsWith("?") && !key.startsWith("#"));
    if (!tag || !Array.isArray(record[tag])) continue;
    const attrs: Record<string, string> = {};
    if (record[":@"] && typeof record[":@"] === "object") {
      for (const [key, value] of Object.entries(record[":@"])) attrs[key.replace(/^@_/, "").toUpperCase()] = String(value);
    }
    result.push({ tag: tag.toUpperCase(), attrs, children: elements(record[tag] as unknown[]) });
  }
  return result;
}
function nodeText(node: Element | string): string {
  if (typeof node === "string") return node;
  if (["SCRIPT", "STYLE"].includes(node.tag) || /^SECTION/.test(node.tag)) return "";
  if (["BR", "PGBRK"].includes(node.tag)) return "\n";
  return node.children.map(nodeText).join("") + (["P", "TR", "TITLE", "TD", "TH", "TE"].includes(node.tag) ? "\n" : "");
}
function clean(node: Element | string) {
  return nodeText(node).replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}
function blocksOf(nodes: Array<Element | string>, title = "본문", path = ""): Block[] {
  const blocks: Block[] = [];
  let heading = title;
  let subtitle = "";
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (typeof node === "string") continue;
    const nodePath = path + "/" + node.tag + "[" + i + "]";
    if (node.tag === "TITLE" || /^H[1-6]$/.test(node.tag)) {
      heading = clean(node); subtitle = "";
      blocks.push({ node, text: heading, title: heading, subtitle, path: nodePath });
    } else if (["P", "TABLE"].includes(node.tag)) {
      const text = clean(node);
      if (!text) continue;
      if (node.tag === "P" && text.length < 100 && keywords(text).some(k => k !== "수주") &&
          !/[。;※＃]/.test(text)) subtitle = text;
      blocks.push({ node, text, title: heading, subtitle, path: nodePath });
      // Recover later sections nested inside malformed DART table markup.
      const recover = (children: Array<Element | string>, parent: string) => {
        children.forEach((child, index) => {
          if (typeof child === "string") return;
          if (/^SECTION/.test(child.tag)) blocks.push(...blocksOf([child], heading, parent));
          else recover(child.children, parent + "/" + child.tag + "[" + index + "]");
        });
      };
      recover(node.children, nodePath);
    } else if (!["SCRIPT", "STYLE"].includes(node.tag)) {
      const nested = blocksOf(node.children, heading, nodePath);
      // Library wrappers may contain the subsection heading just before a table.
      if (node.tag === "LIBRARY") {
        for (const block of nested) if (block.subtitle) subtitle = block.subtitle;
      }
      blocks.push(...nested);
    }
  }
  return blocks;
}
function rowsOf(table: Element) {
  const rows: Array<{ cells: RawCell[]; header: boolean }> = [];
  function visit(node: Element, head: boolean) {
    if (node !== table && (node.tag === "TABLE" || /^SECTION/.test(node.tag))) return;
    if (node.tag === "TR") {
      const cells = node.children.filter((c): c is Element => typeof c !== "string" && ["TD", "TH", "TE"].includes(c.tag))
        .map(cell => ({
          text: clean(cell), tag: cell.tag,
          rowSpan: Math.max(1, Math.min(1000, Number(cell.attrs.ROWSPAN) || 1)),
          colSpan: Math.max(1, Math.min(100, Number(cell.attrs.COLSPAN) || 1)),
        }));
      if (cells.length) rows.push({ cells, header: head || cells.every(c => c.tag === "TH") });
      return;
    }
    for (const child of node.children) if (typeof child !== "string") visit(child, head || node.tag === "THEAD");
  }
  visit(table, false);
  return rows;
}
function expanded(rows: RawCell[][]): string[][] {
  const grid: string[][] = [];
  rows.forEach((row, r) => {
    grid[r] ??= [];
    let column = 0;
    for (const cell of row) {
      while (grid[r][column] !== undefined) column++;
      for (let dr = 0; dr < cell.rowSpan; dr++) {
        grid[r + dr] ??= [];
        for (let dc = 0; dc < cell.colSpan; dc++) grid[r + dr][column + dc] = cell.text;
      }
      column += cell.colSpan;
    }
  });
  return grid;
}
function parseTable(table: Element, before: string, after: string): RawOrderTable {
  const parsed = rowsOf(table);
  let headerCount = 0;
  while (headerCount < parsed.length && parsed[headerCount].header) headerCount++;
  let headerSource: RawOrderTable["headerSource"] = headerCount ? "explicit" : "none";
  // A header inside TBODY is common in DART. Mark the inference explicitly.
  if (!headerCount && parsed[0]?.cells.length > 1 &&
      parsed[0].cells.some(c => /품목|구분|구 분|수주|contract|orders/i.test(c.text))) {
    headerCount = 1; headerSource = "inferred";
    while (parsed[headerCount]?.cells.every(c => /^(금액|수량)$/.test(c.text))) headerCount++;
  }
  const headerCells = parsed.slice(0, headerCount).map(row => row.cells);
  const grid = expanded(headerCells);
  const width = Math.max(0, ...grid.map(row => row.length));
  const columns = Array.from({ length: width }, (_, c) => [...new Set(grid.map(row => row[c]).filter(Boolean))].join(" / "));
  return {
    columns, headerRows: headerCells.map(row => row.map(cell => cell.text)), headerSource,
    // Physical rows are deliberately not coerced into financial field names.
    rows: parsed.slice(headerCount).map(row => row.cells.map(cell => cell.text)),
    cells: parsed.map(row => row.cells), contextBefore: before, contextAfter: after,
  };
}
export function extractOrderSections(xml: string, sourceFile: string): OrderSection[] {
  if (/<!ENTITY/i.test(xml)) throw new DartError("DART_DOCUMENT_INVALID", "원문에 지원하지 않는 XML 엔터티 선언이 있습니다.");
  let nodes;
  try {
    nodes = elements(new XMLParser({
      preserveOrder: true, ignoreAttributes: false, parseTagValue: false,
      trimValues: false, htmlEntities: true,
      unpairedTags: /<DOCUMENT[\s>]/i.test(xml) ? [] : ["br", "BR", "img", "IMG", "hr", "HR", "meta", "META", "link", "LINK", "input", "INPUT"],
    }).parse(xml));
  } catch { throw new DartError("DART_DOCUMENT_INVALID", "DART 원문 XML/HTML을 해석할 수 없습니다."); }
  const blocks = blocksOf(nodes);
  const sections: OrderSection[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const hits = keywords(block.text);
    const isTable = block.node.tag === "TABLE";
    // Ignore TOC keyword hits; keep narrative mentions as evidence.
    if (/\.{5}|목\s*차/.test(block.title)) continue;
    if (!hits.length && !(isTable && block.subtitle && keywords(block.subtitle).length)) continue;
    // Unit-only tables are retained as adjacent context, not separate data tables.
    if (isTable && rowsOf(block.node).every(row => row.cells.length <= 2) && /단위/.test(block.text) && !hits.length) continue;
    const context = (start: number, end: number) => blocks.slice(start, end)
      .filter(b => b.title === block.title && (b.node.tag !== "TABLE" || /단위|기준일/.test(b.text) && b.text.length < 200))
      .map(b => b.text).join("\n");
    const before = context(Math.max(0, i - 4), i);
    const after = context(i + 1, Math.min(blocks.length, i + 3));
    sections.push({
      title: block.subtitle || block.title, sectionTitle: block.title,
      text: isTable ? [before, block.text, after].filter(Boolean).join("\n") : block.text,
      matchedKeywords: [...new Set([...hits, ...keywords(block.subtitle)])],
      sourceFile, sourcePath: block.path,
      tables: isTable ? [parseTable(block.node, before, after)] : [],
    });
  }
  return sections;
}
