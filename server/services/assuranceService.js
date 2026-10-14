// server/services/assuranceService.js - Commercial Assurance (Part 4)
// Each check compares two independently stored sources and returns PASS/FAIL with the numbers.
const { all, get, r2 } = require('./util');

const TOL = 0.005;
const near = (a, b, tol = TOL) => Math.abs((a ?? 0) - (b ?? 0)) <= tol;

function runAssurance(run) {
  const p = { run: run.run_id };
  const checks = [];
  const add = (group, id, name, expected, actual, pass, detail = '') =>
    checks.push({ id, group, name, expected, actual, status: pass ? 'PASS' : 'FAIL', detail });
  const count = (t) => get(`SELECT COUNT(*) n FROM ${t} WHERE run_id = @run`, p).n;
  const num = (sql) => get(sql, p).v ?? 0;

  /* ---------- 1. History completeness ---------- */
  const tables = ['customers', 'transactions', 'transaction_items', 'inventory_batches', 'inventory_movements',
    'replenishment_orders', 'expiry_events', 'cash_ledger', 'store_brain_events', 'missed_demand'];
  const rowCounts = Object.fromEntries(tables.map((t) => [t, count(t)]));
  const summaries = count('daily_summaries'), contexts = count('day_context');
  const salesDays = num("SELECT COUNT(DISTINCT day) v FROM cash_ledger WHERE run_id = @run AND type = 'sales'");
  add('History completeness', 'H1', 'Run status', 'completed', run.status, run.status === 'completed');
  add('History completeness', 'H2', 'Days retained (daily summaries)', '60/60', `${summaries}/60`, summaries === 60);
  add('History completeness', 'H3', 'Days retained (day context)', '60/60', `${contexts}/60`, contexts === 60);
  add('History completeness', 'H4', 'Days with a recorded sales cash entry', '60/60', `${salesDays}/60`, salesDays === 60);
  const empty = ['customers', 'transactions', 'transaction_items', 'inventory_movements', 'replenishment_orders', 'cash_ledger', 'store_brain_events']
    .filter((t) => rowCounts[t] === 0);
  add('History completeness', 'H5', 'Audit tables contain records (transactions, inventory, replenishment, Store Brain, cash)',
    'all non-empty', empty.length ? `empty: ${empty.join(', ')}` : 'all non-empty', empty.length === 0);
  const cfg = get('SELECT COUNT(*) n FROM run_config WHERE run_id = @run', p).n;
  const prodCost = num('SELECT SUM(opening_qty * unit_cost) v FROM run_products WHERE run_id = @run');
  add('History completeness', 'H6', 'Configuration frozen and opening inventory within budget',
    `config stored, cost <= A$${run.inventory_budget}`, `config ${cfg ? 'stored' : 'MISSING'}, cost A$${r2(prodCost)}`,
    cfg === 1 && prodCost <= run.inventory_budget);

  /* ---------- 2. Inventory reconciliation ---------- */
  const perProduct = all(`SELECT p.product_id, p.name, p.opening_qty,
      COALESCE((SELECT SUM(o.qty_ordered) FROM replenishment_orders o WHERE o.run_id = p.run_id AND o.product_id = p.product_id AND o.arrival_day <= 60),0) received,
      COALESCE((SELECT SUM(i.quantity) FROM transaction_items i WHERE i.run_id = p.run_id AND i.product_id = p.product_id),0) sold,
      COALESCE((SELECT SUM(e.quantity) FROM expiry_events e WHERE e.run_id = p.run_id AND e.product_id = p.product_id),0) expired,
      COALESCE((SELECT SUM(m.qty_change) FROM inventory_movements m WHERE m.run_id = p.run_id AND m.product_id = p.product_id),0) closing_recorded
    FROM run_products p WHERE p.run_id = @run ORDER BY p.product_id`, p)
    .map((x) => ({ ...x, closing_expected: x.opening_qty + x.received - x.sold - x.expired,
      reconciles: x.opening_qty + x.received - x.sold - x.expired === x.closing_recorded }));
  const T = (k) => perProduct.reduce((s, x) => s + x[k], 0);
  const openBatches = num("SELECT SUM(qty_received) v FROM inventory_batches WHERE run_id = @run AND source = 'opening'");
  const rcvBatches = num("SELECT SUM(qty_received) v FROM inventory_batches WHERE run_id = @run AND source = 'replenishment'");
  const soldMoves = -num("SELECT SUM(qty_change) v FROM inventory_movements WHERE run_id = @run AND type = 'sold'");
  const expMoves = -num("SELECT SUM(qty_change) v FROM inventory_movements WHERE run_id = @run AND type = 'expired'");
  const closeMoves = num('SELECT SUM(qty_change) v FROM inventory_movements WHERE run_id = @run');
  add('Inventory', 'I1', 'Opening units: catalogue snapshot = opening batches', T('opening_qty'), openBatches, T('opening_qty') === openBatches);
  add('Inventory', 'I2', 'Replenishment received: orders = received batches', T('received'), rcvBatches, T('received') === rcvBatches);
  add('Inventory', 'I3', 'Units sold: transaction lines = inventory movements', T('sold'), soldMoves, T('sold') === soldMoves);
  add('Inventory', 'I4', 'Units expired: write-off records = inventory movements', T('expired'), expMoves, T('expired') === expMoves);
  add('Inventory', 'I5', 'Opening + received - sold - expired = closing stock',
    T('opening_qty') + T('received') - T('sold') - T('expired'), closeMoves,
    T('opening_qty') + T('received') - T('sold') - T('expired') === closeMoves,
    `${T('opening_qty')} + ${T('received')} - ${T('sold')} - ${T('expired')}`);
  const bad = perProduct.filter((x) => !x.reconciles);
  add('Inventory', 'I6', `Per-product reconciliation (${perProduct.length} products)`, '0 mismatches', `${bad.length} mismatches`, bad.length === 0,
    bad.map((x) => x.product_id).join(', '));
  const closeVal = num(`SELECT SUM(m.qty_change * b.unit_cost) v FROM inventory_movements m
    JOIN inventory_batches b ON b.batch_id = m.batch_id WHERE m.run_id = @run`);
  const sumVal = num('SELECT closing_inventory_value v FROM daily_summaries WHERE run_id = @run AND day = 60');
  add('Inventory', 'I7', 'Closing inventory value: movements x cost = Day 60 summary', r2(sumVal), r2(closeVal), near(closeVal, sumVal, 0.05));
  const dayStock = all('SELECT product_id, day, SUM(qty_change) d FROM inventory_movements WHERE run_id = @run GROUP BY product_id, day ORDER BY product_id, day', p);
  let running = 0, lastPid = null, minStock = 0;
  for (const r of dayStock) { if (r.product_id !== lastPid) { running = 0; lastPid = r.product_id; } running += r.d; minStock = Math.min(minStock, running); }
  const negBatches = num(`SELECT COUNT(*) v FROM (SELECT batch_id FROM inventory_movements WHERE run_id = @run GROUP BY batch_id HAVING SUM(qty_change) < 0)`);
  add('Inventory', 'I8', 'Negative stock (lowest end-of-day stock of any product)', '>= 0', minStock, minStock >= 0);
  add('Inventory', 'I9', 'Overselling (batches sold below zero)', 0, negBatches, negBatches === 0);
  const expSales = num(`SELECT COUNT(*) v FROM inventory_movements m JOIN inventory_batches b ON b.batch_id = m.batch_id
    WHERE m.run_id = @run AND m.type = 'sold' AND b.expiry_day IS NOT NULL AND m.day >= b.expiry_day`);
  add('Inventory', 'I10', 'Expired-product sales', 0, expSales, expSales === 0);

  /* ---------- 3. Revenue reconciliation ---------- */
  const badDays = all(`SELECT s.day, s.revenue, COALESCE((SELECT SUM(t.total_amount) FROM transactions t WHERE t.run_id = s.run_id AND t.day = s.day),0) txn
    FROM daily_summaries s WHERE s.run_id = @run`, p).filter((d) => !near(d.revenue, d.txn));
  add('Revenue', 'R1', 'Daily revenue = sum of recorded transaction totals (60 days)', '0 mismatching days', `${badDays.length} mismatching days`,
    badDays.length === 0, badDays.map((d) => `D${d.day}`).join(', '));
  const sumDaily = num('SELECT SUM(revenue) v FROM daily_summaries WHERE run_id = @run');
  const sumTxn = num('SELECT SUM(total_amount) v FROM transactions WHERE run_id = @run');
  add('Revenue', 'R2', '60-day revenue = sum of daily revenue figures', r2(sumTxn), r2(sumDaily), near(sumDaily, sumTxn));
  const sumLines = num('SELECT SUM(line_total) v FROM transaction_items WHERE run_id = @run');
  add('Revenue', 'R3', 'Transaction line totals = transaction totals', r2(sumTxn), r2(sumLines), near(sumLines, sumTxn));
  const badTxn = num(`SELECT COUNT(*) v FROM transactions t WHERE t.run_id = @run AND
    ABS(t.total_amount - COALESCE((SELECT SUM(i.line_total) FROM transaction_items i WHERE i.txn_id = t.txn_id),0)) > 0.005`);
  add('Revenue', 'R4', 'Every transaction equals the sum of its own lines', '0 mismatches', `${badTxn} mismatches`, badTxn === 0);
  const sumCogs = num('SELECT SUM(cogs) v FROM daily_summaries WHERE run_id = @run');
  const lineCogs = num('SELECT SUM(quantity * unit_cost) v FROM transaction_items WHERE run_id = @run');
  add('Revenue', 'R5', 'COGS: daily summaries = transaction lines', r2(lineCogs), r2(sumCogs), near(sumCogs, lineCogs, 0.05));
  const sumCust = num('SELECT SUM(customers) v FROM daily_summaries WHERE run_id = @run');
  const sumUnits = num('SELECT SUM(units_sold) v FROM daily_summaries WHERE run_id = @run');
  add('Revenue', 'R6', 'Customers, transactions and units: summaries = raw records',
    `${rowCounts.customers} / ${rowCounts.transactions} / ${T('sold')}`,
    `${sumCust} / ${num('SELECT SUM(transactions) v FROM daily_summaries WHERE run_id = @run')} / ${sumUnits}`,
    sumCust === rowCounts.customers && num('SELECT SUM(transactions) v FROM daily_summaries WHERE run_id = @run') === rowCounts.transactions && sumUnits === T('sold'));

  /* ---------- 4. Operating cash reconciliation ---------- */
  const spend = num("SELECT -SUM(amount) v FROM cash_ledger WHERE run_id = @run AND type = 'replenishment'");
  const closing = num('SELECT closing_cash v FROM daily_summaries WHERE run_id = @run AND day = 60');
  const expectedCash = run.opening_cash + sumTxn - spend;
  add('Operating cash', 'C1', 'Closing cash = opening cash + sales revenue - replenishment spending',
    r2(expectedCash), r2(closing), near(expectedCash, closing, 0.05), `${run.opening_cash} + ${r2(sumTxn)} - ${r2(spend)}`);
  const lastLedger = get('SELECT balance_after v FROM cash_ledger WHERE run_id = @run ORDER BY entry_id DESC LIMIT 1', p).v;
  add('Operating cash', 'C2', 'Last ledger balance = Day 60 closing cash', r2(closing), r2(lastLedger), near(closing, lastLedger, 0.05));
  const ledgerBreaks = num(`SELECT COUNT(*) v FROM (SELECT amount, balance_after, LAG(balance_after) OVER (ORDER BY entry_id) prev
    FROM cash_ledger WHERE run_id = @run) WHERE prev IS NOT NULL AND ABS(balance_after - (prev + amount)) > 0.005`);
  add('Operating cash', 'C3', 'Every cash entry follows from the previous balance', '0 breaks', `${ledgerBreaks} breaks`, ledgerBreaks === 0);
  const overspent = num('SELECT COUNT(*) v FROM replenishment_orders WHERE run_id = @run AND total_cost > cash_before + 0.005');
  add('Operating cash', 'C4', 'Replenishment never exceeds cash available when the order was placed', '0 orders', `${overspent} orders`, overspent === 0);
  const minBal = num('SELECT MIN(balance_after) v FROM cash_ledger WHERE run_id = @run');
  add('Operating cash', 'C5', 'Cash balance never negative (lowest balance)', '>= 0', r2(minBal), minBal >= 0);
  const orderCost = num('SELECT SUM(total_cost) v FROM replenishment_orders WHERE run_id = @run');
  add('Operating cash', 'C6', 'Replenishment spending: cash ledger = order records', r2(orderCost), r2(spend), near(orderCost, spend, 0.05));
  const unexplained = num(`SELECT (SELECT COUNT(*) FROM cash_ledger WHERE run_id = @run AND type = 'replenishment' AND order_id IS NULL)
    + (SELECT COUNT(*) FROM replenishment_orders o WHERE o.run_id = @run AND o.total_cost > 0 AND NOT EXISTS (SELECT 1 FROM cash_ledger c WHERE c.order_id = o.order_id)) v`);
  add('Operating cash', 'C7', 'Unexplained cash movements (spend without an order, or an order without spend)', 0, unexplained, unexplained === 0);
  const badSpendDays = num(`SELECT COUNT(*) v FROM daily_summaries s WHERE s.run_id = @run AND ABS(s.replenishment_spend -
    COALESCE((SELECT SUM(o.total_cost) FROM replenishment_orders o WHERE o.run_id = s.run_id AND o.placed_day = s.day),0)) > 0.005`);
  add('Operating cash', 'C8', 'Daily spending: summaries = orders placed that day', '0 mismatching days', `${badSpendDays} mismatching days`, badSpendDays === 0);

  /* ---------- 5. Rules of the daily cycle ---------- */
  const lead = num('SELECT COUNT(*) v FROM replenishment_orders WHERE run_id = @run AND arrival_day <> placed_day + 1');
  const arrive = num(`SELECT COUNT(*) v FROM inventory_batches b JOIN replenishment_orders o ON o.order_id = b.order_id
    WHERE b.run_id = @run AND b.received_day <> o.arrival_day`);
  add('Daily cycle', 'D1', 'One-day lead time: stock arrives the day after the order', '0 exceptions', `${lead + arrive} exceptions`, lead + arrive === 0);
  const day60 = num('SELECT COUNT(*) v FROM replenishment_orders WHERE run_id = @run AND placed_day >= 60');
  add('Daily cycle', 'D2', 'No order placed after the close of Day 60', 0, day60, day60 === 0);
  const unlinked = num("SELECT COUNT(*) v FROM store_brain_events WHERE run_id = @run AND condition = 'replenishment' AND order_id IS NULL");
  add('Daily cycle', 'D3', 'Every Store Brain replenishment action links to a recorded order', '0 unlinked', `${unlinked} unlinked`, unlinked === 0);

  /* ---------- Business outcomes (NOT integrity failures) ---------- */
  const ev = (c) => num(`SELECT COUNT(*) v FROM store_brain_events WHERE run_id = @run AND condition = '${c}'`);
  const business = [
    { item: 'Sold-out product-days', value: ev('sold_out') },
    { item: 'Low-stock events', value: ev('low_stock') },
    { item: 'Expiry write-off value (A$)', value: r2(num('SELECT SUM(value) v FROM expiry_events WHERE run_id = @run')) },
    { item: 'Lost sales (A$)', value: r2(num('SELECT SUM(lost_revenue) v FROM missed_demand WHERE run_id = @run')) },
    { item: 'Slow-mover flags', value: ev('slow_mover') },
    { item: 'Cash-constrained orders', value: num('SELECT COUNT(*) v FROM replenishment_orders WHERE run_id = @run AND cash_constrained = 1') },
  ].map((b) => ({ ...b, note: 'Business outcome recorded correctly; not an integrity failure.' }));

  const failed = checks.filter((c) => c.status === 'FAIL');
  return {
    run_id: run.run_id, generated_from: 'stored run history (recomputed on request)',
    overall: failed.length ? 'FAIL' : 'PASS', total_checks: checks.length, passed: checks.length - failed.length, failed: failed.length,
    history: { days_retained: `${summaries}/60`, record_counts: rowCounts },
    checks, exceptions: failed,
    exceptions_note: failed.length ? 'Integrity failures are listed above and affect any figure that relies on them.'
      : 'No integrity failures or unexplained exceptions were found.',
    inventory_by_product: perProduct, business_outcomes: business,
  };
}

module.exports = { runAssurance };
