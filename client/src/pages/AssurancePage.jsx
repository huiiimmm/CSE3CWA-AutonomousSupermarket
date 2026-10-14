// Part 4: Commercial Assurance - every check compares two independently stored sources.
import { Load, A, KV, Prod, Table, num } from '../ui';

const fmt = (v) => (typeof v === 'number' ? num(v, Number.isInteger(v) ? 0 : 2) : v);
const Status = ({ s }) => <span className={s === 'PASS' ? 'pass' : 'fail'}>{s}</span>;

export function AssuranceView({ data }) {
  return (
    <>
      <h1>Commercial Assurance</h1>
      <p><Status s={data.overall} /> {data.passed} of {data.total_checks} checks passed for run <b>{data.run_id}</b>. Days retained: {data.history.days_retained}.
        <span className="muted"> Recomputed from the stored history each time this page loads.</span></p>
      <p>{data.exceptions_note}</p>

      <h2>Checks</h2>
      <Table cols={[['Group', 'group'], ['ID', 'id'], ['Check', 'name'], ['Expected', (c) => fmt(c.expected), 'r'], ['Actual', (c) => fmt(c.actual), 'r'], ['Status', (c) => <Status s={c.status} />]]} rows={data.checks} />

      <h2>Exceptions</h2>
      <Table cols={[['ID', 'id'], ['Check', 'name'], ['Expected', (c) => fmt(c.expected)], ['Actual', (c) => fmt(c.actual)]]} rows={data.exceptions} empty="No integrity failures or unexplained exceptions." />

      <h2>Records retained</h2>
      <KV rows={Object.entries(data.history.record_counts).map(([k, v]) => [k, num(v)])} />

      <details>
        <summary>Inventory reconciliation by product ({data.inventory_by_product.length} products)</summary>
        <Table cols={[['Product', (r) => <Prod id={r.product_id} name={r.name} />], ['Opening', (r) => num(r.opening_qty), 'r'], ['+ Received', (r) => num(r.received), 'r'],
          ['- Sold', (r) => num(r.sold), 'r'], ['- Expired', (r) => num(r.expired), 'r'], ['= Expected', (r) => num(r.closing_expected), 'r'],
          ['Recorded', (r) => num(r.closing_recorded), 'r'], ['', (r) => <Status s={r.reconciles ? 'PASS' : 'FAIL'} />]]} rows={data.inventory_by_product} />
      </details>

      <h2>Business outcomes (not integrity failures)</h2>
      <p className="muted">Stockouts, slow movers, write-offs and low cash can be legitimate simulated outcomes. See <A to="/report">the report</A> for how they were handled.</p>
      <KV rows={data.business_outcomes.map((b) => [b.item, fmt(b.value)])} />
    </>
  );
}

export default function AssurancePage() {
  return <Load path="/assurance">{(d) => <AssuranceView data={d} />}</Load>;
}
