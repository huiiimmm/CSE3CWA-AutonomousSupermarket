// Traceability: product history and transaction detail.
import { Load, A, KV, Prod, Table, money, num, nice } from '../ui';

export function ProductView({ data }) {
  const p = data.product, t = data.totals;
  return (
    <>
      <h1>{p.name} ({p.product_id})</h1>
      <p>{p.category}. Cost {money(p.unit_cost, 2)}, price {money(p.unit_price, 2)}, {p.is_perishable ? `perishable (${p.shelf_life_days}-day shelf life)` : 'non-perishable'}.</p>
      <KV rows={[['Opening', num(t.opening)], ['+ Received', num(t.received)], ['- Sold', num(t.sold)], ['- Expired', num(t.expired)], ['= Closing', num(t.closing)], ['Unmet demand', num(t.unmet_demand)]]} />
      <h3>Orders</h3>
      <Table cols={[['Order', (r) => `#${r.order_id}`], ['Placed', (r) => <A to={`/day/${r.placed_day}`}>Day {r.placed_day}</A>], ['Wanted', 'qty_wanted', 'r'], ['Ordered', 'qty_ordered', 'r'], ['Cost', (r) => money(r.total_cost, 2), 'r']]} rows={data.orders} />
      <h3>Write-offs</h3>
      <Table cols={[['Day', (r) => <A to={`/day/${r.day}`}>{r.day}</A>], ['Batch', 'batch_id', 'r'], ['Units', 'quantity', 'r'], ['Value', (r) => money(r.value, 2), 'r']]} rows={data.write_offs} />
      <h3>Store Brain alerts</h3>
      <Table cols={[['Day', (r) => <A to={`/day/${r.day}`}>{r.day}</A>], ['Condition', (r) => nice(r.condition)], ['Rule that fired', 'detail']]} rows={data.store_brain_events.filter((e) => e.condition !== 'replenishment').slice(0, 40)} />
      <details>
        <summary>Stock movements by day (60 days)</summary>
        <Table cols={[['Day', (r) => <A to={`/day/${r.day}`}>{r.day}</A>], ['Opening', 'opening', 'r'], ['Received', 'received', 'r'], ['Sold', 'sold', 'r'], ['Expired', 'expired', 'r'], ['Unmet', 'unmet_demand', 'r'], ['Closing stock', 'closing_stock', 'r']]} rows={data.daily} />
      </details>
    </>
  );
}

export function TransactionView({ data }) {
  const t = data.transaction, ok = Math.abs(data.check.sum_of_lines - data.check.recorded_total) < 0.005;
  return (
    <>
      <h1>Transaction #{t.txn_id}</h1>
      <p><A to={`/day/${t.day}`}>Day {t.day}</A>, {String(Math.floor(t.minute_of_day / 60)).padStart(2, '0')}:{String(t.minute_of_day % 60).padStart(2, '0')}, mission: {nice(t.mission)}.</p>
      <Table cols={[['Product', (r) => <Prod id={r.product_id} name={r.name} />], ['Qty', 'quantity', 'r'], ['Price', (r) => money(r.unit_price, 2), 'r'], ['Line total', (r) => money(r.line_total, 2), 'r'],
        ['Stock batch', (r) => `#${r.batch_id}, ${r.batch_source}, received Day ${r.received_day}${r.expiry_day ? `, expires Day ${r.expiry_day}` : ''}`]]} rows={data.items} />
      <p>Sum of lines {money(data.check.sum_of_lines, 2)} = recorded total {money(data.check.recorded_total, 2)}: <span className={ok ? 'pass' : 'fail'}>{ok ? 'PASS' : 'FAIL'}</span></p>
    </>
  );
}

export const ProductPage = ({ id }) => <Load path={`/products/${id}/history`}>{(d) => <ProductView data={d} />}</Load>;
export const TransactionPage = ({ id }) => <Load path={`/transactions/${id}`}>{(d) => <TransactionView data={d} />}</Load>;
