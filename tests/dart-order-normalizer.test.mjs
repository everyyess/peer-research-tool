import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";

const localRequire = createRequire(import.meta.url);
const exported = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL("../app/lib/dart-order-normalizer.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: exported, require: name => name === "server-only" ? {} : localRequire(name) });
const { normalizeDartOrders, parseOrderNumber } = exported;
const fixtures = JSON.parse(readFileSync(new URL("./fixtures/dart-orders-2026-half.json", import.meta.url), "utf8"));
const copy = value => JSON.parse(JSON.stringify(value));

test("numeric strings preserve missing values and reject malformed / unsafe numbers", () => {
  for (const [raw, expected] of [[" 1,939,091 ", 1939091], [" (1,234) ", -1234], ["-17", -17], ["0", 0],
    ["1,234.50", 1234.5], ["-", null], [" ", null], [null, null], ["12,34", null], ["합계", null], ["1억원", null],
    ["9007199254740992", null]]) assert.equal(parseOrderNumber(raw), expected);
});
test("actual report cells match expected conversion; raw payload stays unchanged", () => {
  const expected = [
    [1939091, null, "USD", "천USD", null],
    [69998, 6999800000000, "KRW", "억원", 34677],
    [12310500, 12310500000000, "KRW", "백만원", null],
    [23834404, 23834404000000, "KRW", "백만원", 11010478],
  ];
  fixtures.forEach((raw, i) => {
    const original = JSON.stringify(raw);
    const p = normalizeDartOrders(raw).primary;
    assert.deepEqual([p.backlogValue, p.backlogKRW, p.currency, p.unit, p.newOrders], expected[i]);
    assert.equal(p.provenance.rceptNo, raw.report.rceptNo);
    assert.equal(parseOrderNumber(p.backlogRaw), p.backlogValue);
    const source = p.provenance.rawTable.cells[p.provenance.sourceRow];
    assert.ok(source.some(cell => cell.text === p.backlogRaw));
    assert.equal(JSON.stringify(raw), original);
  });
});
test("merged totals: Iljin geography, LS subsidiaries, Hyosung construction exclusion", () => {
  const iljin = normalizeDartOrders(fixtures[0]).primary;
  assert.equal(iljin.domesticBacklog, 468895);
  assert.equal(iljin.overseasBacklog, 1470196);
  assert.equal(iljin.domesticBacklog + iljin.overseasBacklog, iljin.totalBacklog);
  const ls = normalizeDartOrders(fixtures[1]);
  assert.equal(ls.primary.scope, "LS ELECTRIC");
  assert.equal(ls.subsidiaries.length, 6);
  assert.equal(ls.subsidiaries.find(s => s.scope === "LS티라유텍").newOrders, null);
  const hyosung = normalizeDartOrders(fixtures[3]).primary;
  assert.equal(hyosung.scope, "중공업 부문");
  assert.equal(hyosung.backlogValue, 23834404);
});
test("unknown, absent and ambiguous tables fail closed", () => {
  for (const raw of [{...fixtures[0], stockCode:"999999"}, {...fixtures[0], orderSections:[]},
    {...fixtures[0], orderSections:[...fixtures[0].orderSections,...fixtures[0].orderSections]}]) {
    const p=normalizeDartOrders(raw).primary;
    assert.equal(p.normalizationStatus,"raw_only");assert.equal(p.backlogKRW,null);
  }
});
test("unknown unit never silently assumes KRW", () => {
  const raw=copy(fixtures[2]);
  raw.orderSections.forEach(s=>s.tables.forEach(t=>{t.contextBefore=t.contextBefore.replace(/백만원/g,"불명");}));
  const p=normalizeDartOrders(raw).primary;
  assert.equal(p.backlogKRW,null);assert.equal(p.unit,null);assert.equal(p.normalizationStatus,"partially_normalized");
});
test("LS matching keeps company and subsidiaries separate when table order changes", () => {
  const raw=copy(fixtures[1]);
  raw.orderSections.reverse();
  const result=normalizeDartOrders(raw);
  assert.equal(result.primary.backlogValue,69998);
  assert.equal(result.primary.newOrders,34677);
});

test("KRW unit factors and null/negative backlog cells are handled without estimation", () => {
  for (const [unit, multiplier] of [["원", 1], ["천원", 1000], ["백만원", 1000000], ["억원", 100000000]]) {
    const raw=copy(fixtures[2]);
    raw.orderSections.forEach(s=>s.tables.forEach(t=>{t.contextBefore=t.contextBefore.replace(/백만원/g,unit);}));
    assert.equal(normalizeDartOrders(raw).primary.backlogKRW,12310500*multiplier);
  }
  for (const [text,value] of [["-",null],["(1,234)",-1234],["0",0]]) {
    const raw=copy(fixtures[2]);
    raw.orderSections.forEach(s=>s.tables.forEach(t=>t.cells.forEach(r=>r.forEach(c=>{
      if(c.text==="12,310,500")c.text=text;
    }))));
    const p=normalizeDartOrders(raw).primary;
    assert.equal(p.backlogValue,value);
    assert.equal(p.backlogKRW,value===null?null:value*1000000);
    assert.equal(p.newOrders,null);
  }
});
