// Daily Report: one view with a day selector.
import { useState } from 'react';
import { useApi, useRun } from '../api';
import { Load, A, KV, Prod, Table, money, num, nice } from '../ui';

const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export function DayView({ data: d, days }) {
  const s = d.summary, c = d.context, raw = d.raw_totals;
  const row = (k, a, b) => ({ k, a, b, ok: String(a) === String(b) });
  return (
    <>
      <h1>Daily Report: Day {d.day} ({c.weekday_name})</h1>
      <p>
        <label>Day <select value={d.day} onChange={(e) => { window.location.hash = `#/day/${e.target.value}`; }}>
          {days.map((x) => <option key={x.day} value={x.day}>{x.day} {x.weekday_name}{x.special_event ? ' *' : ''}</option>)}
        </select></label>{' '}
        {d.previous_day && <A to={`/day/${d.previous_day}`}>Previous</A>} {d.next_day && <A to={`/day/${d.next_day}`}>Next</A>}
      </p>
      <p>{c.special_event ? `Special event: ${c.special_event}. ` : ''}Expected customers {num(c.expected_customers)}: base x {c.day_type_multiplier} (day type) x {c.noise_multiplier} (noise) x {c.event_multiplier} (event).</p>

      <h3>Summary</h3>
      <Table cols={[['', 'k'], ['Daily summary', 'a', 'r'], ['Raw records', 'b', 'r'], ['Match', (r) => <span className={r.ok ? 'pass' : 'fail'}>{r.ok ? 'PASS' : 'FAIL'}</span>]]} rows={[
        row('Customers', num(s.customers), num(raw.customers)), row('Transactions', num(s.transactions), num(raw.transactions)),
        row('Units sold', num(s.units_sold), num(raw.units)), row('Revenue', money(s.revenue, 2), money(raw.revenue, 2))]} />
      <KV rows={[
        ['COGS / gross profit', `${money(s.cogs, 2)} / ${money(s.gross_profit, 2)}`], ['Write-offs', money(s.writeoff_value, 2)], ['Replenishment spend', money(s.replenishment_spend, 2)],
        ['Cash: opening + sales - spend = closing', `${money(d.cash.opening_balance, 2)} + ${money(d.cash.sales, 2)} - ${money(d.cash.replenishment_spend, 2)} = ${money(d.cash.closing_balance, 2)}`],
        ['Closing inventory value', money(s.closing_inventory_value, 2)],
      ]} />

      <h3>Top products</h3>
      <Table cols={[['Product', (r) => <Prod id={r.product_id} name={r.name} />], ['Units', 'units', 'r'], ['Revenue', (r) => money(r.revenue, 2), 'r']]} rows={d.top_products.slice(0, 5)} />
      <h3>Unmet demand</h3>
      <Table cols={[['Product', (r) => <Prod id={r.product_id} name={r.name} />], ['Units unmet', 'units_missed', 'r'], ['Lost revenue', (r) => money(r.lost_revenue, 2), 'r']]} rows={d.unmet_demand} />
      <h3>Expired and written off</h3>
      <Table cols={[['Product', (r) => <Prod id={r.product_id} name={r.name} />], ['Batch', 'batch_id', 'r'], ['Units', 'quantity', 'r'], ['Value', (r) => money(r.value, 2), 'r']]} rows={d.write_offs} />
      <h3>Orders placed at close (arrive Day {d.day + 1})</h3>
      <Table cols={[['Order', (r) => `#${r.order_id}`], ['Product', (r) => <Prod id={r.product_id} name={r.name} />], ['Wanted', 'qty_wanted', 'r'], ['Ordered', 'qty_ordered', 'r'], ['Cost', (r) => money(r.total_cost, 2), 'r'], ['Cash-limited', (r) => (r.cash_constrained ? 'Yes' : 'No')]]}
        rows={d.orders_placed} empty={d.day === 60 ? 'No order is placed after the close of Day 60.' : 'None (0).'} />

      <h3>Store Brain alerts</h3>
      <Table cols={[['Condition', (r) => nice(r.condition)], ['Product', (r) => (r.product_id ? <Prod id={r.product_id} name={r.product} /> : '-')], ['Action', 'action'], ['Rule that fired', 'detail'], ['Outcome', 'outcome']]}
        rows={d.store_brain.events.filter((e) => e.condition !== 'replenishment')} empty="No alerts today." />
      <p className="muted">{d.store_brain.counts.replenishment || 0} replenishment decisions are the orders above.</p>

      <Transactions day={d.day} />
    </>
  );
}

function Transactions({ day }) {
  const { runId } = useRun();
  const [offset, setOffset] = useState(0);
  const { data, error, loading } = useApi(`/runs/${runId}/days/${day}/transactions?limit=20&offset=${offset}`);
  return (
    <>
      <h3>Transactions</h3>
      {error && <p className="error">{error}</p>}
      {loading && <p className="muted">Loading...</p>}
      {data && (
        <>
          <Table cols={[['Transaction', (r) => <A to={`/txn/${r.txn_id}`}>#{r.txn_id}</A>], ['Time', (r) => hhmm(r.minute_of_day)], ['Mission', (r) => nice(r.mission)], ['Units', 'units', 'r'], ['Total', (r) => money(r.total_amount, 2), 'r']]} rows={data.transactions} />
          <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>Previous</button>{' '}
          {offset + 1}-{Math.min(offset + 20, data.total)} of {num(data.total)}{' '}
          <button disabled={offset + 20 >= data.total} onClick={() => setOffset(offset + 20)}>Next</button>
        </>
      )}
    </>
  );
}

export default function DayPage({ day }) {
  return <Load path="/days">{(days) => <Load path={`/days/${day}`}>{(d) => <DayView data={d} days={days.days} />}</Load>}</Load>;
}
