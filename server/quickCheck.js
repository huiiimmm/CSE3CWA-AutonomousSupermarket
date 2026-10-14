// server/quickCheck.js - development sanity check on a stored run (not the Assurance feature)
//   node quickCheck.js <runId>
const db = require('./db');
const runId = process.argv[2];
if (!runId) { console.error('usage: node quickCheck.js <runId>'); process.exit(1); }
const one = (sql) => db.prepare(sql).get(runId);
const r2 = (x) => Math.round(x * 100) / 100;
const rows = {};
for (const t of ['customers','transactions','transaction_items','inventory_batches','inventory_movements',
  'missed_demand','replenishment_orders','expiry_events','cash_ledger','store_brain_events','day_context','daily_summaries'])
  rows[t] = one(`SELECT COUNT(*) n FROM ${t} WHERE run_id = ?`).n;
console.log('row counts:', JSON.stringify(rows));

const run = one('SELECT * FROM runs WHERE run_id = ?');
const last = one('SELECT * FROM daily_summaries WHERE run_id = ? AND day = 60');
const stockValue = one(`SELECT SUM(m.qty_change * b.unit_cost) v FROM inventory_movements m
  JOIN inventory_batches b ON b.batch_id = m.batch_id WHERE m.run_id = ?`).v;
const negBatches = one(`SELECT COUNT(*) n FROM (SELECT batch_id FROM inventory_movements WHERE run_id = ?
  GROUP BY batch_id HAVING SUM(qty_change) < 0)`).n;
const expiredSales = one(`SELECT COUNT(*) n FROM inventory_movements m JOIN inventory_batches b ON b.batch_id = m.batch_id
  WHERE m.run_id = ? AND m.type = 'sold' AND b.expiry_day IS NOT NULL AND m.day >= b.expiry_day`).n;
const dayRevBad = one(`SELECT COUNT(*) n FROM daily_summaries d WHERE d.run_id = ? AND
  ROUND(d.revenue, 2) <> ROUND(COALESCE((SELECT SUM(total_amount) FROM transactions t WHERE t.run_id = d.run_id AND t.day = d.day), 0), 2)`).n;
const itemsVsTxn = one(`SELECT ROUND((SELECT SUM(line_total) FROM transaction_items WHERE run_id = ?1) -
  (SELECT SUM(total_amount) FROM transactions WHERE run_id = ?1), 2) d`).d;
const revenue = one('SELECT SUM(revenue) v FROM daily_summaries WHERE run_id = ?').v;
const spend = one(`SELECT -SUM(amount) v FROM cash_ledger WHERE run_id = ? AND type = 'replenishment'`).v || 0;
const ledgerCash = db.prepare('SELECT balance_after FROM cash_ledger WHERE run_id = ? ORDER BY entry_id DESC LIMIT 1').get(runId).balance_after;
const overspend = one('SELECT COUNT(*) n FROM replenishment_orders WHERE run_id = ? AND total_cost > cash_before').n;

const checks = {
  'run completed with 60 summaries': run.status === 'completed' && rows.daily_summaries === 60 && rows.day_context === 60,
  'stock value from movements = closing inventory': Math.abs(r2(stockValue) - last.closing_inventory_value) < 0.05,
  'no negative batches': negBatches === 0,
  'no expired-product sales': expiredSales === 0,
  'daily revenue = sum of transactions': dayRevBad === 0,
  'item lines = transaction totals': itemsVsTxn === 0,
  'closing cash = opening + revenue - spend': Math.abs(r2(run.opening_cash + revenue - spend) - last.closing_cash) < 0.05,
  'ledger balance = summary cash': Math.abs(ledgerCash - last.closing_cash) < 0.05,
  'no order above cash available': overspend === 0,
};
for (const [k, v] of Object.entries(checks)) console.log(v ? 'PASS' : 'FAIL', k);
