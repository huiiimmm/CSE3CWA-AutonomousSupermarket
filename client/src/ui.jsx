// Tiny shared pieces: formatting, links, data loading, plain tables, one bar chart.
import { useApi, useRun } from './api';

export const num = (x, d = 0) => (x == null ? '-' : Number(x).toLocaleString('en-AU', { minimumFractionDigits: d, maximumFractionDigits: d }));
export const money = (x, d = 0) => (x == null ? '-' : 'A$' + num(x, d));
export const nice = (s) => String(s || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

export const A = ({ to, children }) => <a href={'#' + to}>{children}</a>;
export const Prod = ({ id, name }) => <A to={`/product/${id}`}>{name || id}</A>;

// cols: [[heading, keyOrFunction, 'r'?], ...]
export function Table({ cols, rows, empty = 'None (0).' }) {
  if (!rows || !rows.length) return <p>{empty}</p>;
  return (
    <table>
      <thead><tr>{cols.map(([h, , align]) => <th key={h} className={align}>{h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => (
        <tr key={i}>{cols.map(([h, get, align]) => <td key={h} className={align}>{typeof get === 'function' ? get(r) : r[get]}</td>)}</tr>
      ))}</tbody>
    </table>
  );
}

// rows: [[label, value], ...]
export const KV = ({ rows }) => (
  <table className="kv"><tbody>{rows.map(([k, v]) => <tr key={k}><th>{k}</th><td>{v}</td></tr>)}</tbody></table>
);

// One simple bar chart. href(d) makes a bar a link.
export function Bars({ data, x, y, href, color, title }) {
  const W = 720, H = 130, max = Math.max(1, ...data.map((d) => d[y])), bw = W / data.length;
  return (
    <svg viewBox={`0 0 ${W} ${H + 16}`} className="bars" role="img">
      {data.map((d, i) => {
        const h = (d[y] / max) * H;
        const bar = <rect x={i * bw + 1} y={H - h} width={bw - 2} height={h} fill={color ? color(d) : '#2563eb'}><title>{title ? title(d) : `${d[x]}: ${num(d[y])}`}</title></rect>;
        return <g key={i}>{href ? <a href={'#' + href(d)}>{bar}</a> : bar}{i % 10 === 0 && <text x={i * bw} y={H + 13} fontSize="10">{d[x]}</text>}</g>;
      })}
      <text x={W - 2} y="10" fontSize="10" textAnchor="end">max {num(max)}</text>
    </svg>
  );
}

// <Load path="/report/performance">{(data) => ...}</Load> - fetches for the run being viewed
export function Load({ path, children }) {
  const { runId } = useRun();
  const { data, error, loading } = useApi(`/runs/${runId}${path}`);
  if (error) return <p className="error">{error}</p>;
  if (loading) return <p className="muted">Loading...</p>;
  return children(data);
}
