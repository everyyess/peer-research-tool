"use client";

import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { Activity, ArrowUpRight, ChartNoAxesCombined, CircleAlert, Loader2, Plus, Trash2, Users } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Cell, LabelList, Line, LineChart, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from "recharts";
import type { PeerAnalysisResponse, PeerMetrics } from "@/app/api/peer-analysis/route";

const COLORS = ["#2563eb", "#089981", "#d99720", "#8757c7", "#db5976", "#0e9fb5", "#e37535", "#68758c"];
const METRICS = [
  { key: "revenueGrowthYoY", label: "매출 성장 YoY", unit: "%" },
  { key: "revenueGrowthQoQ", label: "매출 성장 QoQ", unit: "%" },
  { key: "epsGrowthFwd", label: "EPS 성장", unit: "%" },
  { key: "operatingMargin", label: "영업이익률", unit: "%" },
  { key: "roe", label: "ROE", unit: "%" },
  { key: "dividendYield", label: "배당수익률", unit: "%" },
  { key: "inventoryQoQ", label: "재고 증감 QoQ", unit: "%" },
  { key: "per", label: "PER", unit: "배" },
  { key: "forwardPer", label: "선행 PER", unit: "배" },
  { key: "pbr", label: "PBR", unit: "배" },
  { key: "psr", label: "PSR", unit: "배" },
  { key: "pegRatio", label: "PEG", unit: "배" },
] as const;
type MetricKey = (typeof METRICS)[number]["key"];
type InputPeer = { id: number; name: string; symbol: string };
type ChartPeer = PeerMetrics & { color: string; series: string };
// Three symbols verified in the reference project's sector master.
// Iljin was absent there; its symbol comes from the user's explicit example.
const INITIAL: InputPeer[] = [
  { id: 0, name: "일진전기", symbol: "103590.KS" },
  { id: 1, name: "LS ELECTRIC", symbol: "010120.KS" },
  { id: 2, name: "HD현대일렉트릭", symbol: "267260.KS" },
  { id: 3, name: "효성중공업", symbol: "298040.KS" },
];
const tick = { fontSize: 11, fill: "#8390a2" };
const numeric = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const numberOrNull = (v: unknown) => numeric(v) ? v : null;
const fmt = (v: unknown, unit = "") => numeric(v) ? v.toLocaleString("ko-KR", { maximumFractionDigits: 1 }) + unit : "—";
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length ? sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2 : null;
};
function capLabel(peer: PeerMetrics) {
  if (!numeric(peer.marketCap)) return "시총 정보 없음";
  return new Intl.NumberFormat("ko-KR", { notation: "compact", maximumFractionDigits: 1 }).format(peer.marketCap) + " " + (peer.currency ?? "");
}
function Empty({ children }: { children: ReactNode }) {
  return <div className="chart-empty"><ChartNoAxesCombined size={26} /><p>{children}</p></div>;
}
function Card({ number, title, description, children, controls }: { number: string; title: string; description: string; children: ReactNode; controls?: ReactNode }) {
  return <section className="panel chart-panel"><div className="card-heading"><div><div className="eyebrow">{number} / PEER COMPARISON</div><h2>{title}</h2><p>{description}</p></div>{controls}</div>{children}</section>;
}
function Band({ peer, metric }: { peer: ChartPeer; metric: "per" | "pbr" }) {
  const current = peer[metric];
  const low = peer[metric === "per" ? "perLow52" : "pbrLow52"];
  const high = peer[metric === "per" ? "perHigh52" : "pbrHigh52"];
  const valid = numeric(low) && numeric(high) && high >= low;
  const position = valid && numeric(current) ? high === low ? 50 : Math.max(0, Math.min(100, (current - low) / (high - low) * 100)) : null;
  const outside = valid && numeric(current) && (current < low || current > high);
  return <div className="band-row"><div className="band-name"><span className="dot" style={{ background: peer.color }} />{peer.name}<strong>{fmt(current, "배")}</strong></div>
    {valid ? <><div className="band-track" style={{ background: peer.color + "22" }}>{position !== null && <span className="band-marker" style={{ left: position + "%", background: peer.color }} title={"현재 " + fmt(current, "배")} />}</div><div className="band-labels"><span>LOW {fmt(low, "배")}</span><span>{outside ? "현재 값은 밴드 범위 밖" : "● 현재"}</span><span>HIGH {fmt(high, "배")}</span></div></> : <div className="band-unavailable">52주 밴드 데이터 없음 · 현재 {fmt(current, "배")}</div>}
  </div>;
}

export default function PeerAnalysis() {
  const [inputs, setInputs] = useState(INITIAL);
  const nextId = useRef(4);
  const [data, setData] = useState<PeerAnalysisResponse | null>(null);
  const [submitted, setSubmitted] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [band, setBand] = useState<"per" | "pbr">("per");
  const [xKey, setXKey] = useState<MetricKey>("revenueGrowthYoY");
  const [yKey, setYKey] = useState<MetricKey>("per");
  const normalized = inputs.map(({ name, symbol }) => ({ name: name.trim(), symbol: symbol.trim().toUpperCase() }));
  const dirty = data && submitted !== JSON.stringify(normalized);
  async function analyze(event: FormEvent) {
    event.preventDefault();
    if (loading) return;
    if (normalized.length < 2 || normalized.length > 8) { setError("비교 기업은 2~8개를 입력해주세요."); return; }
    if (normalized.some(p => !p.name || !p.symbol)) { setError("모든 기업의 기업명과 Yahoo Finance 심볼을 입력해주세요."); return; }
    if (new Set(normalized.map(p => p.symbol)).size !== normalized.length) { setError("같은 심볼이 중복되어 있습니다. 서로 다른 기업을 입력해주세요."); return; }
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/peer-analysis", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ peers: normalized }), signal: AbortSignal.timeout(90_000),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "분석 요청에 실패했습니다. (" + response.status + ")");
      if (!Array.isArray(body.peers) || typeof body.asOf !== "string") throw new Error("분석 응답 형식이 올바르지 않습니다.");
      setData(body); setSubmitted(JSON.stringify(normalized));
    } catch (err) {
      setError(err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError") ? "조회 시간이 초과되었습니다. 잠시 후 다시 실행해주세요." : err instanceof Error ? err.message : "분석 중 오류가 발생했습니다.");
    } finally { setLoading(false); }
  }
  const allPeers: ChartPeer[] = (data?.peers ?? []).map((p, i) => ({ ...p, color: COLORS[i % COLORS.length], series: "peer" + i }));
  const peers = allPeers.filter(p => !p.error);
  const growth = METRICS.slice(0, 3).map(m => ({ metric: m.label, ...Object.fromEntries(peers.map(p => [p.series, numberOrNull(p[m.key])])) }));
  const hasGrowth = peers.some(p => METRICS.slice(0, 3).some(m => numeric(p[m.key])));
  const years = [...new Set(peers.flatMap(p => p.annuals.map(a => a.year)))].sort();
  const annuals = years.map(year => ({ year, ...Object.fromEntries(peers.map(p => [p.series, numberOrNull(p.annuals.find(a => a.year === year)?.operatingMargin)])) }));
  const hasAnnuals = peers.some(p => p.annuals.some(a => numeric(a.operatingMargin)));
  const xMetric = METRICS.find(m => m.key === xKey)!;
  const yMetric = METRICS.find(m => m.key === yKey)!;
  const points = peers.flatMap(p => numeric(p[xKey]) && numeric(p[yKey]) ? [{ ...p, x: p[xKey], y: p[yKey], z: numeric(p.marketCap) && p.marketCap > 0 ? p.marketCap : 0 }] : []);
  const medX = median(points.map(p => p.x));
  const medY = median(points.map(p => p.y));
  const maxCap = Math.max(1, ...points.map(p => p.z));
  const missingPoints = peers.filter(p => !numeric(p[xKey]) || !numeric(p[yKey]));
  const mixedCurrencies = new Set(points.map(p => p.currency).filter(Boolean)).size > 1;
  const pctTooltip = (value: unknown) => fmt(value, "%");

  return <div className="research-app">
    <header className="topbar"><div className="brand"><span className="brand-icon"><ChartNoAxesCombined size={20} /></span>PEER<span className="brand-sub">RESEARCH TOOL</span></div><span className="source-badge"><span />Yahoo Finance · 6시간 캐시</span></header>
    <main className="dashboard">
      <div className="page-heading"><div><div className="eyebrow">EQUITY RESEARCH / COMPARATIVE ANALYSIS</div><h1>기업의 가치를, 나란히.</h1><p>직접 고른 기업들의 성장, 밸류에이션과 수익성을 한눈에 비교하세요.</p></div><div className="heading-mark">Peer<br /><strong>Research.</strong></div></div>
      <section className="panel selection-panel"><div className="selection-heading"><div><h2><Users size={19} />비교 기업 <span className="count">{inputs.length} / 8</span></h2><p>기업명과 Yahoo Finance 심볼을 입력하세요. 최소 2개, 최대 8개까지 비교할 수 있습니다.</p></div><span className="example-tag">직접 선택하는 비교 그룹</span></div>
        <form onSubmit={analyze}><fieldset disabled={loading}><div className="peer-input-grid">{inputs.map((peer, i) => <div className="peer-input" key={peer.id}><div className="input-title"><span>COMPANY {String(i + 1).padStart(2, "0")}</span><button type="button" className="icon-button" aria-label={peer.name + " 행 삭제"} disabled={inputs.length <= 2} onClick={() => setInputs(inputs.filter(p => p.id !== peer.id))}><Trash2 size={15} /></button></div><label htmlFor={"name-" + peer.id}>기업명</label><input id={"name-" + peer.id} value={peer.name} placeholder="예: 일진전기" onChange={e => setInputs(inputs.map(p => p.id === peer.id ? { ...p, name: e.target.value } : p))} /><label htmlFor={"symbol-" + peer.id}>Yahoo Finance 심볼</label><input id={"symbol-" + peer.id} className="symbol-input" spellCheck={false} value={peer.symbol} placeholder="예: 103590.KS" onChange={e => setInputs(inputs.map(p => p.id === peer.id ? { ...p, symbol: e.target.value } : p))} /></div>)}</div><div className="form-footer"><button type="button" className="secondary-button" disabled={inputs.length >= 8} onClick={() => setInputs([...inputs, { id: nextId.current++, name: "", symbol: "" }])}><Plus size={16} />기업 추가</button><span className="form-hint">입력한 기업명은 차트에 그대로 표시됩니다.</span><button className="primary-button" type="submit">{loading ? <Loader2 className="spin" size={17} /> : <Activity size={17} />}{loading ? "분석 데이터 수집 중" : "Peer 분석 실행"}{!loading && <ArrowUpRight size={17} />}</button></div></fieldset></form>
      </section>
      {error && <div className="alert error" role="alert"><CircleAlert size={18} /><span>{error}{data && " 아래는 이전 분석 결과입니다."}</span></div>}
      {loading && <div className="alert loading" role="status"><Loader2 size={18} className="spin" />분기·연간 재무 데이터를 수집하고 있습니다. 첫 조회는 시간이 걸릴 수 있습니다.{data && " 아래는 이전 분석 결과입니다."}</div>}
      {dirty && !loading && <div className="alert notice" role="status">비교 기업이 변경되었습니다. 아래는 이전 분석 결과입니다. ‘Peer 분석 실행’을 눌러 반영하세요.</div>}
      {!data ? <div className="panel welcome"><span className="welcome-icon"><ChartNoAxesCombined size={32} /></span><h2>나만의 Peer 그룹으로 시작하세요</h2><p>기본 기업을 수정하거나 그대로 분석해보세요.</p><div className="welcome-features"><span>01 성장률 비교</span><span>02 PER / PBR 밴드</span><span>03 수익성 사이클</span><span>04 Peer 사분면</span></div></div> : <div aria-busy={loading}>
        <div className="results-heading"><div><h2>Peer 비교 분석 <span className="count">{peers.length}개 기업</span></h2><p>조회 시각 {new Date(data.asOf).toLocaleString("ko-KR")} · 결측값은 — 로 표시</p></div><div className="peer-legend">{allPeers.map(p => <span key={p.symbol}><span className="dot" style={{ background: p.color }} />{p.name}{p.error && " · 수집 실패"}</span>)}</div></div>
        {allPeers.filter(p => p.error).map(p => <div className="alert error" role="alert" key={p.symbol}><CircleAlert size={17} /><span><strong>{p.name} ({p.symbol})</strong> · {p.error}</span></div>)}
        {peers.length < 2 && <div className="alert notice">유효한 기업 데이터가 {peers.length}개입니다. 기업 간 비교를 위해 심볼을 확인하고 다시 실행해주세요.</div>}
        <section className="panel summary"><table><caption className="sr-only">기업별 주요 지표</caption><thead><tr><th>기업 / 심볼</th><th>시가총액</th><th>매출 YoY</th><th>EPS 성장</th><th>PER</th><th>PBR</th><th>영업이익률</th><th>ROE</th></tr></thead><tbody>{peers.map(p => <tr key={p.symbol}><th><span className="dot" style={{ background: p.color }} />{p.name}<small>{p.symbol}</small></th><td>{capLabel(p)}</td><td>{fmt(p.revenueGrowthYoY, "%")}</td><td>{fmt(p.epsGrowthFwd, "%")}</td><td>{fmt(p.per, "배")}</td><td>{fmt(p.pbr, "배")}</td><td>{fmt(p.operatingMargin, "%")}</td><td>{fmt(p.roe, "%")}</td></tr>)}</tbody></table>{!peers.length && <p className="table-empty">표시할 기업 데이터가 없습니다.</p>}</section>
        <div className="charts-grid">
          <Card number="01" title="성장률 비교" description="매출과 이익의 성장 속도 · 단위 %">
            {hasGrowth ? <div className="chart"><ResponsiveContainer width="100%" height="100%" minWidth={1}><BarChart data={growth} margin={{ top: 20, right: 12, bottom: 8, left: 0 }}><CartesianGrid vertical={false} stroke="#edf0f5" /><XAxis dataKey="metric" tick={tick} tickLine={false} axisLine={false} /><YAxis tick={tick} tickLine={false} axisLine={false} /><ReferenceLine y={0} stroke="#c3ccda" /><Tooltip formatter={pctTooltip} />{peers.map(p => <Bar key={p.symbol} name={p.name} dataKey={p.series} fill={p.color} maxBarSize={28} radius={[3, 3, 0, 0]} isAnimationActive={false} />)}</BarChart></ResponsiveContainer></div> : <Empty>비교할 성장률 데이터가 없습니다.</Empty>}
            <p className="chart-note">EPS 성장은 향후 1년 컨센서스 우선, 없으면 최근 이익 성장률입니다.</p>
          </Card>
          <Card number="02" title="PER / PBR 52주 밴드" description="현재 EPS/BPS 고정 근사 · ● 현재 위치" controls={<div className="segmented">{(["per", "pbr"] as const).map(m => <button key={m} onClick={() => setBand(m)} aria-pressed={band === m} className={band === m ? "active" : ""}>{m.toUpperCase()}</button>)}</div>}>
            <div className="bands">{peers.length ? peers.map(p => <Band key={p.symbol} peer={p} metric={band} />) : <Empty>밴드를 표시할 기업이 없습니다.</Empty>}</div><p className="chart-note">52주 고저가에 현재 EPS/BPS를 적용한 범위이며, 과거 실제 배수 이력은 아닙니다.</p>
          </Card>
          <Card number="03" title="수익성 사이클" description="기업별 연간 영업이익률 추이 · 단위 %">
            {hasAnnuals ? <div className="chart"><ResponsiveContainer width="100%" height="100%" minWidth={1}><LineChart data={annuals} margin={{ top: 20, right: 20, bottom: 8, left: 0 }}><CartesianGrid vertical={false} stroke="#edf0f5" /><XAxis dataKey="year" tick={tick} tickLine={false} axisLine={false} /><YAxis tick={tick} tickLine={false} axisLine={false} /><ReferenceLine y={0} stroke="#c3ccda" /><Tooltip formatter={pctTooltip} />{peers.map(p => <Line key={p.symbol} name={p.name} dataKey={p.series} stroke={p.color} strokeWidth={2.5} dot={{ r: 4, strokeWidth: 2, fill: "#fff" }} connectNulls={false} isAnimationActive={false} />)}</LineChart></ResponsiveContainer></div> : <Empty>연간 영업이익률 데이터가 없습니다.</Empty>}
            <p className="chart-note">기업별 최근 연간 데이터 기준 · 누락된 연도는 연결하지 않습니다.</p>
          </Card>
          <Card number="04" title="Peer 사분면" description="버블 크기 = 시가총액 · 점선 = 표시 기업의 중앙값">
            <div className="axis-controls">{([{ axis: "X", value: xKey, change: setXKey }, { axis: "Y", value: yKey, change: setYKey }] as const).map(a => <label key={a.axis}>{a.axis}축<select value={a.value} onChange={e => a.change(e.target.value as MetricKey)}>{METRICS.map(m => <option value={m.key} key={m.key}>{m.label}</option>)}</select></label>)}</div>
            {points.length ? <div className="chart scatter"><ResponsiveContainer width="100%" height="100%" minWidth={1}><ScatterChart margin={{ top: 30, right: 45, bottom: 26, left: 22 }}><CartesianGrid stroke="#edf0f5" /><XAxis type="number" dataKey="x" tick={tick} domain={["auto", "auto"]} name={xMetric.label} unit={xMetric.unit} label={{ value: xMetric.label + " (" + xMetric.unit + ")", position: "bottom", offset: 8, fill: "#718096", fontSize: 11 }} /><YAxis type="number" dataKey="y" tick={tick} domain={["auto", "auto"]} name={yMetric.label} unit={yMetric.unit} label={{ value: yMetric.label + " (" + yMetric.unit + ")", angle: -90, position: "insideLeft", offset: -12, fill: "#718096", fontSize: 11 }} /><ZAxis type="number" dataKey="z" domain={[0, maxCap]} range={[70, 1000]} />
              <Tooltip content={({ active, payload }) => { const p = payload?.[0]?.payload as (typeof points)[number] | undefined; return active && p ? <div className="chart-tooltip"><strong>{p.name}</strong><p>{xMetric.label}: {fmt(p.x, xMetric.unit)}</p><p>{yMetric.label}: {fmt(p.y, yMetric.unit)}</p><p>시가총액: {capLabel(p)}</p></div> : null; }} />
              {medX !== null && <ReferenceLine x={medX} stroke="#8390a2" strokeDasharray="5 5" />}{medY !== null && <ReferenceLine y={medY} stroke="#8390a2" strokeDasharray="5 5" />}
              <Scatter data={points} isAnimationActive={false}>{points.map(p => <Cell key={p.symbol} fill={p.color} fillOpacity={0.72} stroke="white" strokeWidth={2} />)}<LabelList dataKey="name" position="top" style={{ fontSize: 10, fill: "#46546a" }} /></Scatter>
            </ScatterChart></ResponsiveContainer></div> : <Empty>선택한 두 지표가 모두 있는 기업이 없습니다.</Empty>}
            <p className="chart-note">중앙값 · X {fmt(medX, xMetric.unit)} / Y {fmt(medY, yMetric.unit)}{missingPoints.length > 0 && " · 지표 누락: " + missingPoints.map(p => p.name).join(", ")}</p>
            {points.some(p => !p.z) && <p className="chart-note">시가총액이 없는 기업은 최소 크기로 표시합니다.</p>}
            {mixedCurrencies && <p className="chart-note">서로 다른 통화가 포함되어 있습니다. 버블 크기는 환율 환산 전 시가총액이므로 통화 간 규모 비교에는 사용할 수 없습니다.</p>}
          </Card>
        </div>
      </div>}
      <footer className="footer"><span>PEER RESEARCH TOOL</span><span>Yahoo Finance · 기업별 재무 제공 범위와 결산 시점이 다를 수 있습니다.</span></footer>
    </main>
  </div>;
}
