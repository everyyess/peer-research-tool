"use client";

import { useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { DART_HISTORY_YEARS, dartHistoryChartData, loadDartPeerHistory, type DartPeerHistory } from "@/app/lib/dart-peer-history";

type Peer = { symbol: string; name: string; color: string };
const tick = { fontSize: 11, fill: "#8390a2" };
const percent = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) + "%" : "—";

export default function DartProfitabilityCycle({ peers }: { peers: Peer[] }) {
  // Stable snapshot avoids requests when unrelated chart controls change.
  const selection = JSON.stringify(peers.map(({ symbol, name }) => ({ symbol, name })));
  const [result, setResult] = useState<{ selection: string; histories: DartPeerHistory[] } | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    void loadDartPeerHistory(JSON.parse(selection)).then(histories => {
      if (active) setResult({ selection, histories });
    });
    return () => { active = false; };
  }, [selection, retry]);
  const loading = result?.selection !== selection;
  const histories = loading ? [] : result.histories;
  const chartData = dartHistoryChartData(histories);
  const hasData = histories.some(peer => peer.points.some(point => point.operatingMargin !== null));
  const missing = histories.flatMap(peer => {
    const points = peer.points.filter(point => point.operatingMargin === null);
    return points.length ? [peer.name + ": " + points.map(point => point.year).join(", ") + " (" + [...new Set(points.map(point => point.error || "영업이익률 미제공"))].join(" / ") + ")"] : [];
  });
  const ofs = histories.flatMap(peer => {
    const years = peer.points.filter(point => point.fsDiv === "OFS").map(point => point.year);
    return years.length ? [peer.name + " " + years.join(", ")] : [];
  });
  return <div data-testid="dart-profitability" aria-busy={loading}>
    {loading ? <div className="chart-empty" role="status"><Loader2 size={24} className="spin" /><p>OpenDART 2022~2025 연간 재무 조회 중…</p></div>
      : hasData ? <div className="chart"><ResponsiveContainer width="100%" height="100%" minWidth={1}>
        <LineChart data={chartData} margin={{ top: 20, right: 20, bottom: 8, left: 0 }}>
          <CartesianGrid vertical={false} stroke="#edf0f5" /><XAxis dataKey="year" tick={tick} tickLine={false} axisLine={false} />
          <YAxis tick={tick} tickLine={false} axisLine={false} /><ReferenceLine y={0} stroke="#c3ccda" />
          <Tooltip formatter={percent} />
          {peers.map((peer, i) => <Line key={peer.symbol} name={peer.name} dataKey={"peer" + i} stroke={peer.color} strokeWidth={2.5}
            dot={{ r: 4, strokeWidth: 2, fill: "#fff" }} connectNulls={false} isAnimationActive={false} />)}
        </LineChart>
      </ResponsiveContainer></div> : <div className="chart-empty"><p>표시할 DART 연간 영업이익률이 없습니다.</p></div>}
    <p className="chart-note">2022~2025 · 단위 % · CFS 우선、없는 경우 API의 OFS 사용 여부를 아래에 표시합니다. Yahoo 값으로 대체하지 않습니다.</p>
    {ofs.length > 0 && <p className="chart-note">별도재무제표(OFS) 사용: {ofs.join(" · ")}</p>}
    {missing.length > 0 && <div role="status"><p className="chart-note">누락 연도는 연결하지 않습니다. {missing.join(" · ")}</p>
      <button type="button" className="secondary-button" style={{ marginTop: 8 }} onClick={() => { setResult(null); setRetry(value => value + 1); }}><RefreshCw size={12} />누락 데이터 다시 조회</button>
    </div>}
    {!loading && <details style={{ marginTop: 12 }}>
      <summary style={{ cursor: "pointer", fontSize: 11, color: "#718096" }}>연간 영업이익률 확인 (차트와 동일 데이터)</summary>
      <div style={{ overflowX: "auto", marginTop: 8 }}>
        <table style={{ minWidth: 430, fontSize: 11 }} aria-label="DART 연간 영업이익률">
          <thead><tr><th>기업</th>{DART_HISTORY_YEARS.map(year => <th key={year}>{year}</th>)}</tr></thead>
          <tbody>{histories.map((peer, i) => <tr key={peer.symbol}><th>{peer.name}</th>{chartData.map(row => <td key={String(row.year)}>{percent(row["peer" + i])}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </details>}
  </div>;
}
