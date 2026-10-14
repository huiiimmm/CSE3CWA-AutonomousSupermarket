// 60-Day Commercial Report on one page: Part 1, Part 2, Part 3.
import { Load, A, Bars, KV, Prod, Table, money, num, nice } from '../ui';

const ORDER = ['low_stock', 'sold_out', 'expiry_warning', 'expired_removed', 'slow_mover', 'replenishment', 'cash_constrained'];

export function Part1({ data }) {
  const { store: s, shoppers: sh, categories, products: p } = data;
  const wk = (k, label) => ({ k: label, ...sh[k] });
  return (
    <>
      <h2>Part 1: Business performance</h2>
      <h3>Store performance</h3>
      <KV rows={[
        ['Customers', `${num(s.customers)} (${num(sh.customers_who_left_empty)} left without buying)`], ['Transactions', num(s.transactions)], ['Units sold', num(s.units_sold)],
        ['Sales revenue', money(s.revenue, 2)], ['COGS', money(s.cogs, 2)], ['Gross profit', `${money(s.gross_profit, 2)} (${num(s.gross_margin_pct, 1)}%)`],
        ['Expiry / write-off', `${money(s.writeoff_value, 2)} (${num(s.writeoff_units)} units)`], ['Closing operating cash', money(s.closing_cash, 2)],
        ['Closing inventory value', money(s.closing_inventory_value, 2)],
      ]} />
      <p className="muted">Gross profit excludes rent, labour and all overheads (outside the model boundary), so it is not store profit.</p>

      <h3>Shoppers and baskets</h3>
      <KV rows={[
        ['Average customers per day', num(sh.avg_customers_per_day)], ['Average transaction value', money(sh.avg_transaction_value, 2)],
        ['Average basket', `${num(sh.avg_units_per_transaction, 2)} units, ${num(sh.avg_distinct_products_per_transaction, 2)} different products`],
      ]} />
      <Table cols={[['', 'k'], ['Days', 'days', 'r'], ['Avg customers', (r) => num(r.avg_customers), 'r'], ['Avg revenue', (r) => money(r.avg_revenue), 'r'], ['Avg transaction', (r) => money(r.avg_transaction_value, 2), 'r']]}
        rows={[wk('weekday', 'Weekday'), wk('weekend', 'Weekend')]} />
      <p className="muted">Customers per day (orange = weekend, red = special-event day). Click a bar to open that day.</p>
      <Bars data={sh.by_day} x="day" y="customers" href={(d) => `/day/${d.day}`} color={(d) => (d.special_event ? '#dc2626' : d.is_weekend ? '#d97706' : '#2563eb')}
        title={(d) => `Day ${d.day} ${d.weekday_name}: ${num(d.customers)} customers${d.special_event ? ' (' + d.special_event + ')' : ''}`} />

      <h3>Categories</h3>
      <Table cols={[['Category', 'category'], ['Units', (r) => num(r.units), 'r'], ['Revenue', (r) => money(r.revenue), 'r'], ['Gross profit', (r) => money(r.gross_profit), 'r'], ['Margin', (r) => `${num(r.margin_pct, 1)}%`, 'r']]} rows={categories} />
      <h3>Top-selling products</h3>
      <Table cols={[['Product', (r) => <Prod id={r.product_id} name={r.name} />], ['Units', (r) => num(r.units), 'r'], ['Revenue', (r) => money(r.revenue), 'r'], ['Gross profit', (r) => money(r.gross_profit), 'r']]} rows={p.top_by_revenue.slice(0, 8)} />
      <h3>Weak or slow-selling products</h3>
      <Table cols={[['Product', (r) => <Prod id={r.product_id} name={r.name} />], ['Units', (r) => num(r.units), 'r'], ['Units/day', (r) => num(r.units_per_day, 1), 'r'], ['Revenue', (r) => money(r.revenue), 'r']]} rows={p.weakest_by_units.slice(0, 5)} />
    </>
  );
}

export function Part2({ data }) {
  const h = data.inventory_health, b = data.store_brain, r = b.responses, cc = b.cash_constraint;
  const of = (x) => `${num(x.responded ?? x.count)} of ${num(x.of)}`;
  return (
    <>
      <h2>Part 2: Inventory and autonomous operations</h2>
      <h3>Inventory health</h3>
      <KV rows={[
        ['Sold-out product-days', `${num(h.stockouts.product_days)} (${h.stockouts.products_affected} products)`], ['Low-stock events', num(h.low_stock.events)],
        ['Unmet demand', `${num(h.lost_sales.unmet_demand_units)} units, ${money(h.lost_sales.lost_revenue, 2)} lost revenue`],
        ['Expired / written off', `${num(h.expiry.units)} units, ${money(h.expiry.value, 2)}`], ['Slow movers flagged', h.slow_moving.count],
        ['Replenishment', `${num(h.replenishment.orders)} orders, ${num(h.replenishment.units_ordered)} units, ${money(h.replenishment.spend)}`],
        ['Closing inventory', `${num(h.closing_position.units)} units, ${money(h.closing_position.value)}`],
      ]} />
      <h3>Most stockouts</h3>
      <Table cols={[['Product', (x) => <Prod id={x.product_id} name={x.name} />], ['Category', 'category'], ['Sold-out days', 'stockout_days', 'r']]} rows={h.stockouts.by_product.slice(0, 5)} />
      <h3>Largest write-offs</h3>
      <Table cols={[['Product', (x) => <Prod id={x.product_id} name={x.name} />], ['Units', (x) => num(x.units), 'r'], ['Value', (x) => money(x.value, 2), 'r']]} rows={h.expiry.by_product.slice(0, 5)} />
      <h3>Slow-moving products</h3>
      <Table cols={[['Flagged', (x) => <A to={`/day/${x.day}`}>Day {x.day}</A>], ['Product', (x) => <Prod id={x.product_id} name={x.name} />], ['Rule that fired', 'detail']]} rows={h.slow_moving.products} />
      <h3>Closing inventory by category</h3>
      <Table cols={[['Category', 'category'], ['Units', (x) => num(x.units), 'r'], ['Value at cost', (x) => money(x.value), 'r']]} rows={h.closing_position.by_category} />

      <h3>Store Brain activity</h3>
      <Table cols={[['Condition', (x) => nice(x.c)], ['Events', (x) => num(x.events), 'r'], ['Products', 'products', 'r']]} rows={ORDER.map((c) => ({ c, ...b.event_counts[c] }))} />
      <KV rows={[
        ['Sold-out products ordered the same day', of(r.sold_out_with_same_day_order)],
        ['Sold-out days followed by another sold-out day', of(r.sold_out_followed_by_another_sold_out)],
        ['Expiry warnings that ended in a write-off', `${num(r.expiry_warnings.ended_in_writeoff)} of ${num(r.expiry_warnings.issued)}`],
        ['Cash-constrained orders', `${num(cc.constrained_orders)} (${num(cc.shortfall_units)} units short)`],
        ['Lowest closing cash', <>{money(cc.lowest_closing_cash)} on <A to={`/day/${cc.lowest_closing_cash_day}`}>Day {cc.lowest_closing_cash_day}</A></>],
      ]} />
      {cc.note && <p className="muted">{cc.note}</p>}
      <h3>Material cases: condition, action, outcome</h3>
      <Table cols={[
        ['Case', (c) => <>{nice(c.type)}: {c.product_id ? <Prod id={c.product_id} name={c.product} /> : ''}</>],
        ['Detected', (c) => (c.condition_detected ? <><A to={`/day/${c.condition_detected.day}`}>Day {c.condition_detected.day}</A>: {c.condition_detected.detail}</> : 'no warning recorded')],
        ['Action', (c) => (c.action_taken?.order_id ? `Order #${c.action_taken.order_id}: ${num(c.action_taken.qty_ordered)} units, ${money(c.action_taken.total_cost, 2)}` : c.action_taken?.action || 'none')],
        ['Recorded outcome', 'recorded_outcome'],
      ]} rows={b.material_cases} />
    </>
  );
}

const CHAIN = [['observation', 'Observation'], ['evidence', 'Evidence'], ['diagnosis', 'Diagnosis'], ['implication', 'Business implication'], ['recommendation', 'Recommendation']];

export function Part3({ data }) {
  return (
    <>
      <h2>Part 3: Diagnosis and recommendations</h2>
      {data.findings.length === 0 && <p className="muted">{data.note}</p>}
      {data.findings.map((f) => (
        <div key={f.finding_no}>
          <h3>Finding {f.finding_no}: {f.title}</h3>
          <KV rows={CHAIN.map(([k, label]) => [label, f[k]])} />
          {f.limitation && <p className="muted">Model limitation: {f.limitation}</p>}
        </div>
      ))}
    </>
  );
}

export default function ReportPage() {
  return (
    <>
      <h1>60-Day Commercial Report</h1>
      <p><A to="/assurance">Part 4: Commercial Assurance</A> is on its own page.</p>
      <Load path="/report/performance">{(d) => <Part1 data={d} />}</Load>
      <Load path="/report/operations">{(d) => <Part2 data={d} />}</Load>
      <Load path="/report/findings">{(d) => <Part3 data={d} />}</Load>
    </>
  );
}
