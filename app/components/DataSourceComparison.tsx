"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeftRight, CircleAlert, Info, Loader2, RefreshCw } from "lucide-react";
import type { PeerAnalysisResponse, PeerMetrics } from "@/app/api/peer-analysis/route";
import {
  annual2025, COMPARISON_METRICS, COMPARISON_YEAR, dartAnnualValue, domesticStockCode,
  formatComparisonValue, formatDifference, sourceDifference, yahooAnnualValue,
  type ComparisonMetric, type ComparisonPeer, type DartComparisonData,
} from "@/app/lib/source-comparison";
import styles from "./DataSourceComparison.module.css";

type SourceState<T> =
  | { status: "loading" }
  | { status: "success"; data: T }
  | { status: "error"; message: string }
  | { status: "unsupported"; message: string };
type ComparisonRow = ComparisonPeer & {
  stockCode: string | null;
  yahoo: SourceState<PeerMetrics>;
  dart: SourceState<DartComparisonData>;
};
function errorMessage(error: unknown) {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
    ? "조회 시간이 초과되었습니다. 다시 조회해주세요."
    : error instanceof Error ? error.message : "데이터를 조회하지 못했습니다.";
}
function sourceStatus<T>({ state, name, detail }: { state: SourceState<T>; name: string; detail: string }) {
  return <div className={styles.sourceState} data-state={state.status}>
    <strong>{name}</strong>
    {state.status === "loading" ? <span><Loader2 size={12} className="spin" />조회 중</span>
      : state.status === "success" ? <span>{detail}</span>
      : <span>{state.status === "error" && <CircleAlert size={12} />}{state.message}</span>}
  </div>;
}
function sourceCell(
  state: SourceState<PeerMetrics> | SourceState<DartComparisonData>,
  value: number | null, metric: ComparisonMetric, source: "yahoo" | "dart",
) {
  if (source === "yahoo" && !metric.yahoo) return <span className={styles.unavailable} title="현재 Yahoo annuals API에서 이 항목을 제공하지 않습니다.">미제공</span>;
  if (state.status === "loading") return <span className={styles.unavailable}>조회 중</span>;
  if (state.status !== "success") return <span title={state.message}>—</span>;
  const data = state.data;
  if (source === "yahoo" && !annual2025(data as PeerMetrics)) return <span title="2025 데이터 없음">—</span>;
  const currency = source === "yahoo" ? (data as PeerMetrics).financialCurrency : (data as DartComparisonData).currency;
  if (metric.kind === "amount" && currency !== "KRW") {
    return <span className={styles.unavailable} title="환율 환산 없이 원화 재무 데이터만 비교합니다.">{currency ? "KRW 아님" : "통화 미확인"}</span>;
  }
  return formatComparisonValue(value, metric.kind);
}

export default function DataSourceComparison({ peers }: { peers: ComparisonPeer[] }) {
  const [rows, setRows] = useState<ComparisonRow[]>([]);
  const [snapshot, setSnapshot] = useState("");
  const [validation, setValidation] = useState("");
  const [requestedAt, setRequestedAt] = useState("");
  const active = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  useEffect(() => () => { active.current?.abort(); sequence.current++; }, []);
  const selection = peers.map(p => ({ name: p.name.trim(), symbol: p.symbol.trim().toUpperCase() }));
  const changed = !!snapshot && snapshot !== JSON.stringify(selection);
  const loading = rows.some(row => row.yahoo.status === "loading" || row.dart.status === "loading");

  async function compare() {
    if (active.current) return;
    if (selection.length < 2 || selection.length > 8 || selection.some(p => !p.name || !p.symbol)) {
      setValidation("상단에서 기업명과 심볼을 입력한 기업 2~8개를 선택해주세요."); return;
    }
    if (new Set(selection.map(p => p.symbol)).size !== selection.length) {
      setValidation("중복된 Yahoo 심볼을 확인해주세요."); return;
    }
    const controller = new AbortController();
    active.current = controller;
    const run = ++sequence.current;
    setValidation("");
    setSnapshot(JSON.stringify(selection));
    setRequestedAt(new Date().toLocaleString("ko-KR"));
    const nextRows: ComparisonRow[] = selection.map(p => {
      const stockCode = domesticStockCode(p.symbol);
      return {
        ...p, stockCode, yahoo: { status: "loading" },
        dart: stockCode ? { status: "loading" } : { status: "unsupported", message: "국내 .KS / .KQ 심볼만 DART 비교 지원" },
      };
    });
    setRows(nextRows);
    function update(symbol: string, patch: Partial<Pick<ComparisonRow, "yahoo" | "dart">>) {
      if (sequence.current === run && !controller.signal.aborted) {
        setRows(current => current.map(row => row.symbol === symbol ? { ...row, ...patch } : row));
      }
    }
    const yahooTask = (async () => {
      try {
        // Keep the existing API's 2–8 peer contract; never request one company at a time.
        const response = await fetch("/api/peer-analysis", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ peers: selection }),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]),
        });
        const body = await response.json() as PeerAnalysisResponse & { error?: string };
        if (!response.ok) throw new Error(body.error || "Yahoo 조회 실패 (" + response.status + ")");
        if (!Array.isArray(body.peers)) throw new Error("Yahoo 응답 형식이 올바르지 않습니다.");
        for (const peer of selection) {
          const found = body.peers.find(p => p.symbol === peer.symbol);
          update(peer.symbol, { yahoo: !found || found.error
            ? { status: "error", message: found?.error || "Yahoo 기업 응답이 없습니다." }
            : { status: "success", data: found } });
        }
      } catch (error) {
        for (const peer of selection) update(peer.symbol, { yahoo: { status: "error", message: errorMessage(error) } });
      }
    })();
    const dartTasks = nextRows.filter(row => row.stockCode).map(async row => {
      try {
        const response = await fetch("/api/dart/financials?" + new URLSearchParams({
          stockCode: row.stockCode!, year: COMPARISON_YEAR, report: "annual",
        }), { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]) });
        const body = await response.json() as DartComparisonData & { error?: string };
        if (!response.ok) throw new Error(body.error || "DART 조회 실패 (" + response.status + ")");
        if (body.stockCode !== row.stockCode || body.businessYear !== COMPARISON_YEAR ||
            body.report !== "annual" || !body.financials || (body.fsDiv !== "CFS" && body.fsDiv !== "OFS")) {
          throw new Error("DART 기업·연도·보고서 응답이 요청과 일치하지 않습니다.");
        }
        update(row.symbol, { dart: { status: "success", data: body } });
      } catch (error) {
        update(row.symbol, { dart: { status: "error", message: errorMessage(error) } });
      }
    });
    await Promise.allSettled([yahooTask, ...dartTasks]);
    if (sequence.current === run) active.current = null;
  }

  return <section className={styles.section} aria-labelledby="source-comparison-title">
    <header className={styles.header}>
      <div><div className="eyebrow">DATA VALIDATION / SOURCE COMPARISON</div>
        <h2 id="source-comparison-title"><ArrowLeftRight size={20} />데이터 소스 비교 <span className={styles.year}>2025 연간 기준</span></h2>
        <p>동일 기업의 연간 재무 데이터를 나란히 확인합니다. 기존 Peer 차트에는 반영되지 않습니다.</p>
      </div>
      <button type="button" className="secondary-button" disabled={loading} onClick={() => void compare()}>
        {loading ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
        {loading ? "소스별 조회 중" : rows.length ? "비교 다시 조회" : "데이터 소스 비교 조회"}
      </button>
    </header>
    <div className={styles.notice}><Info size={16} /><p>Yahoo Finance는 시장·컨센서스 및 일부 재무 데이터를, OpenDART는 국내 공시 기준 재무 데이터를 제공합니다. 동일 항목이라도 연결/별도 기준, 업데이트 시점, TTM/연간 기준 차이로 값이 다를 수 있습니다.</p></div>
    {validation && <p className="alert error" role="alert">{validation}</p>}
    {changed && <p className="alert notice" role="status">상단 기업 목록이 변경되었습니다. 아래는 이전 선택 목록의 결과입니다. {loading ? "현재 조회 완료 후 다시 조회해주세요." : "‘비교 다시 조회’를 눌러 반영하세요."}</p>}
    {!rows.length ? <div className={styles.empty}><div className={styles.chips}>{selection.map((p, i) => <span key={i}>{p.name || "기업명 미입력"} <small>{p.symbol || "심볼 미입력"}</small></span>)}</div><p>비교 조회를 실행하면 Yahoo Finance와 OpenDART 데이터를 각각 가져옵니다.</p></div> : <>
      <div className={styles.meta} role="status"><span>조회 시작 {requestedAt} · {rows.length}개 기업</span><span>금액: KRW · 차이: DART − Yahoo</span></div>
      <div className={styles.grid}>{rows.map(row => {
        const yahoo = row.yahoo.status === "success" ? row.yahoo.data : undefined;
        const dart = row.dart.status === "success" ? row.dart.data : undefined;
        const annual = annual2025(yahoo);
        const busy = row.yahoo.status === "loading" || row.dart.status === "loading";
        return <article key={row.symbol} className={styles.card} aria-busy={busy}>
          <div className={styles.company}><h3>{row.name}</h3><span>{row.symbol}{row.stockCode && " / " + row.stockCode}</span></div>
          <div className={styles.sourceStates} aria-live="polite">
            {sourceStatus({ name: "Yahoo Finance", state: row.yahoo, detail: annual ? "2025 연간 · " + (yahoo?.financialCurrency || "통화 미확인") + " · 연결/별도 미제공" : "2025 데이터 없음" })}
            {sourceStatus({ name: "OpenDART", state: row.dart, detail: dart ? (dart.fsDiv === "CFS" ? "연결 CFS" : "별도 OFS") + " · " + (dart.currency || "통화 미확인") + " · " + dart.corpName : "" })}
          </div>
          <div className={styles.tableWrap}><table className={styles.table}><caption className={styles.srOnly}>{row.name} 2025년 Yahoo Finance와 OpenDART 재무 비교</caption>
            <thead><tr><th scope="col">항목</th><th scope="col">Yahoo Finance</th><th scope="col">OpenDART</th><th scope="col">차이</th></tr></thead>
            <tbody>{COMPARISON_METRICS.map(metric => {
              const y = yahooAnnualValue(yahoo, metric);
              const d = dartAnnualValue(dart, metric);
              const difference = sourceDifference(y, d, metric.kind);
              const notable = difference !== null && Math.abs(difference) >= (metric.kind === "amount" ? 1 : 0.1);
              const zeroDenominator = metric.kind === "amount" && d === 0 && y !== null;
              return <tr key={metric.key}><th scope="row">{metric.label}</th>
                <td>{sourceCell(row.yahoo, y, metric, "yahoo")}</td><td>{sourceCell(row.dart, d, metric, "dart")}</td>
                <td className={notable ? styles.notable : styles.difference} title={zeroDenominator ? "DART 금액이 0이어서 차이율을 계산할 수 없습니다." : metric.kind === "amount" ? "(DART − Yahoo) / |DART| × 100" : "DART − Yahoo (%p)"}>
                  {formatDifference(difference, metric.kind)}
                </td></tr>;
            })}</tbody>
          </table></div>
        </article>;
      })}</div>
    </>}
    <div className={styles.notes}>
      <p>Yahoo는 year = 2025인 annuals만 사용합니다. 다른 연도, TTM, 최근 분기 값으로 대체하지 않습니다.</p>
      <p>현재 Yahoo annuals에서 순이익·재고·자산·부채·자본·부채비율은 미제공입니다. 금액은 원화가 확인된 경우에만 비교합니다.</p>
      <p>금액 차이 = (DART − Yahoo) / |DART| × 100 · 비율 차이 = DART − Yahoo (%p). 결측값 또는 금액의 DART 분모가 0이면 —로 표시합니다.</p>
      <p>강조 기준: 금액 차이의 절댓값 1% 이상 또는 비율 차이 0.10%p 이상. 차이 계산은 반올림 전 원본 값 기준입니다.</p>
    </div>
  </section>;
}
