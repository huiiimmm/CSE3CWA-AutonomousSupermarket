// server/services/reportService.js - Part 1 and Part 2 of the 60-Day Commercial Report,
// the Model Declaration data and the written findings. Everything is computed from stored history.
const { all, get, r2, pct, HttpError } = require('./util');

const BRAIN_CONDITIONS = ['low_stock', 'sold_out', 'expiry_warning', 'expired_removed',
  'slow_mover', 'replenishment', 'cash_constrained'];
const DAYS = 60;

/* ---------------- Run list ---------------- */

function listRuns() {
  return all(`SELECT r.run_id, r.created_at, r.completed_at, r.status, r.random_seed, r.is_submitted,
      (SELECT SUM(revenue) FROM daily_summaries d WHERE d.run_id = r.run_id) revenue,
      (SELECT COUNT(*) FROM daily_summaries d WHERE d.run_id = r.run_id) days_retained
    FROM runs r ORDER BY r.created_at DESC, r.run_id DESC`).map((r) => ({ ...r, revenue: r2(r.revenue) }));
}

/* ---------------- Setup and Model Declaration ---------------- */

function getSetup(run) {
  const p = { run: run.run_id };
  const cost = get('SELECT SUM(opening_qty * unit_cost) v, COUNT(*) n, SUM(is_perishable) per FROM run_products WHERE run_id = @run', p);
  const categories = all(`SELECT category, COUNT(*) products, SUM(opening_qty) units,
      SUM(opening_qty * unit_cost) cost, SUM(opening_qty * unit_price) retail_value
    FROM run_products WHERE run_id = @run GROUP BY category ORDER BY cost DESC`, p)
    .map((c) => ({ ...c, cost: r2(c.cost), retail_value: r2(c.retail_value) }));
  return {
    run, products: cost.n, perishable_products: cost.per,
    inventory_budget: run.inventory_budget, opening_inventory_cost: r2(cost.v),
    budget_headroom: r2(run.inventory_budget - cost.v), opening_cash: run.opening_cash, categories,
  };
}

function getProducts(run, category) {
  const params = { run: run.run_id };
  let sql = 'SELECT product_id, name, category, unit_cost, unit_price, opening_qty, is_perishable, shelf_life_days FROM run_products WHERE run_id = @run';
  if (category) { sql += ' AND category = @category'; params.category = category; }
  return all(sql + ' ORDER BY product_id', params);
}

function getDeclaration(run) {
  const row = get('SELECT config_json FROM run_config WHERE run_id = @run', { run: run.run_id });
  if (!row) throw new HttpError(404, 'No configuration stored for this run');
  return { run_id: run.run_id, random_seed: run.random_seed, config: JSON.parse(row.config_json) };
}

/* ---------------- Part 1: Business Performance ---------------- */

function getPerformance(run) {
  const p = { run: run.run_id };

  // --- store performance (raw tables, not the summary table) ---
  const customers = get('SELECT COUNT(*) n FROM customers WHERE run_id = @run', p).n;
  const txn = get('SELECT COUNT(*) n, COALESCE(SUM(total_amount),0) revenue FROM transactions WHERE run_id = @run', p);
  const items = get('SELECT COALESCE(SUM(quantity),0) units, COALESCE(SUM(quantity*unit_cost),0) cogs FROM transaction_items WHERE run_id = @run', p);
  const wo = get('SELECT COALESCE(SUM(quantity),0) units, COALESCE(SUM(value),0) value FROM expiry_events WHERE run_id = @run', p);
  const cash = get('SELECT balance_after v FROM cash_ledger WHERE run_id = @run ORDER BY entry_id DESC LIMIT 1', p);
  const inv = get(`SELECT COALESCE(SUM(m.qty_change * b.unit_cost),0) value, COALESCE(SUM(m.qty_change),0) units
    FROM inventory_movements m JOIN inventory_batches b ON b.batch_id = m.batch_id WHERE m.run_id = @run`, p);
  const revenue = r2(txn.revenue), cogs = r2(items.cogs);
  const store = {
    customers, transactions: txn.n, units_sold: items.units, revenue, cogs,
    gross_profit: r2(revenue - cogs), gross_margin_pct: pct(revenue - cogs, revenue),
    writeoff_units: wo.units, writeoff_value: r2(wo.value), writeoff_pct_of_cogs: pct(wo.value, cogs),
    closing_cash: r2(cash.v), opening_cash: run.opening_cash, closing_inventory_value: r2(inv.value),
    closing_inventory_units: inv.units,
  };

  // --- shoppers and baskets ---
  const byDay = all(`SELECT d.day, d.weekday_name, d.is_weekend, d.special_event, d.expected_customers,
      (SELECT COUNT(*) FROM customers c WHERE c.run_id = d.run_id AND c.day = d.day) customers,
      (SELECT COUNT(*) FROM transactions t WHERE t.run_id = d.run_id AND t.day = d.day) transactions,
      (SELECT COALESCE(SUM(t.total_amount),0) FROM transactions t WHERE t.run_id = d.run_id AND t.day = d.day) revenue
    FROM day_context d WHERE d.run_id = @run ORDER BY d.day`, p)
    .map((d) => ({ ...d, revenue: r2(d.revenue) }));

  const group = (rows) => {
    const n = rows.length || 1;
    const sum = (k) => rows.reduce((s, d) => s + d[k], 0);
    return { days: rows.length, avg_customers: r2(sum('customers') / n), avg_transactions: r2(sum('transactions') / n),
      avg_revenue: r2(sum('revenue') / n), avg_transaction_value: r2(sum('revenue') / (sum('transactions') || 1)) };
  };
  const weekday = byDay.filter((d) => !d.is_weekend), weekend = byDay.filter((d) => d.is_weekend);
  const lines = get(`SELECT AVG(n) v FROM (SELECT COUNT(DISTINCT product_id) n FROM transaction_items
    WHERE run_id = @run GROUP BY txn_id)`, p).v;

  const hourRows = all(`SELECT c.minute_of_day / 60 hour, d.is_weekend, COUNT(*) n FROM customers c
    JOIN day_context d ON d.run_id = c.run_id AND d.day = c.day WHERE c.run_id = @run GROUP BY hour, d.is_weekend`, p);
  const hourly = Array.from({ length: 24 }, (_, hour) => {
    const per = (we) => r2((hourRows.find((x) => x.hour === hour && x.is_weekend === we)?.n || 0) / ((we ? weekend : weekday).length || 1));
    return { hour, weekday_avg_customers: per(0), weekend_avg_customers: per(1) };
  });

  const missions = all(`SELECT c.mission, COUNT(*) customers, SUM(c.purchased) buyers,
      COALESCE(SUM(t.total_amount),0) revenue
    FROM customers c LEFT JOIN transactions t ON t.customer_id = c.customer_id
    WHERE c.run_id = @run GROUP BY c.mission ORDER BY revenue DESC`, p)
    .map((m) => ({ ...m, revenue: r2(m.revenue), avg_transaction_value: r2(m.buyers ? m.revenue / m.buyers : 0),
      share_of_customers_pct: pct(m.customers, customers) }));

  const shoppers = {
    avg_customers_per_day: r2(customers / DAYS), customers_who_bought: txn.n, customers_who_left_empty: customers - txn.n,
    weekday: group(weekday), weekend: group(weekend),
    avg_units_per_transaction: r2(items.units / (txn.n || 1)), avg_distinct_products_per_transaction: r2(lines),
    avg_transaction_value: r2(revenue / (txn.n || 1)),
    special_event_days: byDay.filter((d) => d.special_event).map((d) => ({ day: d.day, event: d.special_event, customers: d.customers })),
    by_day: byDay, hourly, missions,
  };

  // --- categories and products ---
  const categories = all(`SELECT p.category, SUM(i.quantity) units, SUM(i.line_total) revenue, SUM(i.quantity * i.unit_cost) cogs
    FROM transaction_items i JOIN run_products p ON p.run_id = i.run_id AND p.product_id = i.product_id
    WHERE i.run_id = @run GROUP BY p.category ORDER BY revenue DESC`, p)
    .map((c) => ({ category: c.category, units: c.units, revenue: r2(c.revenue), cogs: r2(c.cogs),
      gross_profit: r2(c.revenue - c.cogs), margin_pct: pct(c.revenue - c.cogs, c.revenue),
      revenue_share_pct: pct(c.revenue, revenue), unit_share_pct: pct(c.units, items.units) }));

  const prods = all(`SELECT p.product_id, p.name, p.category, p.opening_qty,
      COALESCE(SUM(i.quantity),0) units, COALESCE(SUM(i.line_total),0) revenue, COALESCE(SUM(i.quantity * i.unit_cost),0) cogs
    FROM run_products p LEFT JOIN transaction_items i ON i.run_id = p.run_id AND i.product_id = p.product_id
    WHERE p.run_id = @run GROUP BY p.product_id`, p)
    .map((x) => ({ ...x, revenue: r2(x.revenue), cogs: r2(x.cogs), gross_profit: r2(x.revenue - x.cogs),
      units_per_day: r2(x.units / DAYS) }));
  const top = (arr, key, n) => [...arr].sort((a, b) => b[key] - a[key]).slice(0, n);

  return {
    run_id: run.run_id, store, shoppers, categories,
    products: {
      top_by_revenue: top(prods, 'revenue', 10), top_by_units: top(prods, 'units', 10),
      top_by_gross_profit: top(prods, 'gross_profit', 10),
      weakest_by_units: [...prods].sort((a, b) => a.units - b.units).slice(0, 10),
      all: prods,
    },
  };
}

/* ---------------- Part 2: Inventory and Autonomous Operations ---------------- */

function getOperations(run) {
  const p = { run: run.run_id };
  const withName = `JOIN run_products p ON p.run_id = e.run_id AND p.product_id = e.product_id`;
  const byCategory = (rows, keys) => {
    const m = {};
    for (const r of rows) {
      const c = (m[r.category] ||= { category: r.category });
      keys.forEach((k) => (c[k] = r2((c[k] || 0) + r[k])));
    }
    return Object.values(m);
  };

  // --- Store Brain event counts (zero reported, never omitted) ---
  const counts = Object.fromEntries(BRAIN_CONDITIONS.map((c) => [c, { events: 0, products: 0 }]));
  all(`SELECT condition, COUNT(*) n, COUNT(DISTINCT product_id) products FROM store_brain_events
       WHERE run_id = @run GROUP BY condition`, p).forEach((r) => (counts[r.condition] = { events: r.n, products: r.products }));

  // --- stockouts ---
  const stockoutsByProduct = all(`SELECT e.product_id, p.name, p.category, COUNT(*) stockout_days
    FROM store_brain_events e ${withName} WHERE e.run_id = @run AND e.condition = 'sold_out'
    GROUP BY e.product_id ORDER BY stockout_days DESC`, p);
  const lowByProduct = all(`SELECT e.product_id, p.name, p.category, COUNT(*) low_stock_events
    FROM store_brain_events e ${withName} WHERE e.run_id = @run AND e.condition = 'low_stock'
    GROUP BY e.product_id ORDER BY low_stock_events DESC`, p);

  // --- lost sales ---
  const missedByProduct = all(`SELECT m.product_id, p.name, p.category, SUM(m.units_missed) units_missed,
      SUM(m.lost_revenue) lost_revenue, COUNT(*) cases,
      SUM(CASE WHEN m.outcome = 'substituted' THEN 1 ELSE 0 END) substituted_cases
    FROM missed_demand m JOIN run_products p ON p.run_id = m.run_id AND p.product_id = m.product_id
    WHERE m.run_id = @run GROUP BY m.product_id ORDER BY lost_revenue DESC`, p)
    .map((x) => ({ ...x, lost_revenue: r2(x.lost_revenue) }));
  const lost = {
    unmet_demand_units: missedByProduct.reduce((s, x) => s + x.units_missed, 0),
    lost_revenue: r2(missedByProduct.reduce((s, x) => s + x.lost_revenue, 0)),
    cases: missedByProduct.reduce((s, x) => s + x.cases, 0),
    substituted_cases: missedByProduct.reduce((s, x) => s + x.substituted_cases, 0),
    top_products: missedByProduct.slice(0, 10),
  };

  // --- expiry and write-offs ---
  const writeoffByProduct = all(`SELECT e.product_id, p.name, p.category, SUM(e.quantity) units, SUM(e.value) value
    FROM expiry_events e ${withName} WHERE e.run_id = @run GROUP BY e.product_id ORDER BY value DESC`, p)
    .map((x) => ({ ...x, value: r2(x.value) }));

  // --- slow movers ---
  const slow = all(`SELECT e.day, e.product_id, p.name, e.action, e.detail,
      (SELECT COUNT(*) FROM replenishment_orders o WHERE o.run_id = e.run_id AND o.product_id = e.product_id
        AND o.placed_day > e.day AND o.qty_ordered > 0) orders_after_flag
    FROM store_brain_events e ${withName} WHERE e.run_id = @run AND e.condition = 'slow_mover' ORDER BY e.day`, p);

  // --- replenishment ---
  const ord = get(`SELECT COUNT(*) orders, COALESCE(SUM(qty_wanted),0) wanted, COALESCE(SUM(qty_ordered),0) ordered,
      COALESCE(SUM(total_cost),0) spend FROM replenishment_orders WHERE run_id = @run`, p);
  const ordersByProduct = all(`SELECT o.product_id, p.name, p.category, COUNT(*) orders, SUM(o.qty_ordered) units, SUM(o.total_cost) spend
    FROM replenishment_orders o JOIN run_products p ON p.run_id = o.run_id AND p.product_id = o.product_id
    WHERE o.run_id = @run GROUP BY o.product_id ORDER BY spend DESC`, p).map((x) => ({ ...x, spend: r2(x.spend) }));

  // --- closing position ---
  const closing = all(`SELECT p.product_id, p.name, p.category, COALESCE(SUM(m.qty_change),0) units,
      COALESCE(SUM(m.qty_change * b.unit_cost),0) value
    FROM run_products p LEFT JOIN inventory_movements m ON m.run_id = p.run_id AND m.product_id = p.product_id
    LEFT JOIN inventory_batches b ON b.batch_id = m.batch_id
    WHERE p.run_id = @run GROUP BY p.product_id`, p).map((x) => ({ ...x, value: r2(x.value) }));

  // --- cash constraint ---
  const cc = get(`SELECT COUNT(*) orders, COALESCE(SUM(qty_wanted - qty_ordered),0) shortfall_units
    FROM replenishment_orders WHERE run_id = @run AND cash_constrained = 1`, p);
  const lowCash = get('SELECT day, closing_cash FROM daily_summaries WHERE run_id = @run ORDER BY closing_cash LIMIT 1', p);
  const minBefore = get('SELECT MIN(cash_before) v FROM replenishment_orders WHERE run_id = @run', p).v;

  // --- how did the Brain respond? (condition -> action -> recorded outcome) ---
  const soldOutResponded = get(`SELECT COUNT(*) n FROM store_brain_events e WHERE e.run_id = @run AND e.condition = 'sold_out' AND e.day < ${DAYS}
    AND EXISTS (SELECT 1 FROM replenishment_orders o WHERE o.run_id = e.run_id AND o.product_id = e.product_id
                AND o.placed_day = e.day AND o.qty_ordered > 0)`, p).n;
  const soldOutRepeated = get(`SELECT COUNT(*) n FROM store_brain_events e WHERE e.run_id = @run AND e.condition = 'sold_out' AND e.day < ${DAYS}
    AND EXISTS (SELECT 1 FROM store_brain_events f WHERE f.run_id = e.run_id AND f.product_id = e.product_id
                AND f.condition = 'sold_out' AND f.day = e.day + 1)`, p).n;
  const soldOutOpen = get(`SELECT COUNT(*) n FROM store_brain_events WHERE run_id = @run AND condition = 'sold_out' AND day < ${DAYS}`, p).n;
  const lowResponded = get(`SELECT COUNT(*) n FROM store_brain_events e WHERE e.run_id = @run AND e.condition = 'low_stock' AND e.day < ${DAYS}
    AND EXISTS (SELECT 1 FROM replenishment_orders o WHERE o.run_id = e.run_id AND o.product_id = e.product_id
                AND o.placed_day = e.day AND o.qty_ordered > 0)`, p).n;
  const lowOpen = get(`SELECT COUNT(*) n FROM store_brain_events WHERE run_id = @run AND condition = 'low_stock' AND day < ${DAYS}`, p).n;

  // expiry warnings that ended in a write-off (warning text names the batch)
  const expiredBatches = new Set(all('SELECT batch_id FROM expiry_events WHERE run_id = @run', p).map((r) => r.batch_id));
  const warned = all("SELECT detail FROM store_brain_events WHERE run_id = @run AND condition = 'expiry_warning'", p)
    .map((r) => Number((r.detail.match(/batch (\d+)/) || [])[1])).filter(Boolean);
  const warnedSet = new Set(warned);

  // --- material cases: condition -> action -> outcome ---
  const firstEvent = (cond, pid) => get(`SELECT day, action, detail, outcome FROM store_brain_events
    WHERE run_id = @run AND condition = @cond AND product_id = @pid ORDER BY day LIMIT 1`, { run: run.run_id, cond, pid });
  const orderOn = (pid, day) => get(`SELECT order_id, qty_wanted, qty_ordered, total_cost, arrival_day FROM replenishment_orders
    WHERE run_id = @run AND product_id = @pid AND placed_day = @day`, { run: run.run_id, pid, day });
  const cases = [];
  for (const s of stockoutsByProduct.slice(0, 3)) {
    const ev = firstEvent('sold_out', s.product_id);
    const next = ev && ev.day < DAYS ? orderOn(s.product_id, ev.day) : null;
    const lostRow = missedByProduct.find((m) => m.product_id === s.product_id);
    const repeats = get(`SELECT COUNT(*) n FROM store_brain_events e WHERE e.run_id = @run AND e.condition = 'sold_out' AND e.product_id = @pid
      AND e.day < ${DAYS} AND EXISTS (SELECT 1 FROM store_brain_events f WHERE f.run_id = e.run_id AND f.product_id = e.product_id
      AND f.condition = 'sold_out' AND f.day = e.day + 1)`, { run: run.run_id, pid: s.product_id }).n;
    cases.push({ type: 'stockout', product_id: s.product_id, product: s.name, condition_detected: ev,
      action_taken: next, recorded_outcome: `${s.stockout_days} sold-out days; ${repeats} followed by another sold-out day; `
        + `${lostRow ? lostRow.units_missed : 0} units of demand unmet, A$${lostRow ? lostRow.lost_revenue : 0} lost revenue` });
  }
  for (const w of writeoffByProduct.slice(0, 2)) {
    const ev = firstEvent('expiry_warning', w.product_id);
    cases.push({ type: 'write-off', product_id: w.product_id, product: w.name, condition_detected: ev,
      action_taken: ev ? { action: ev.action } : null,
      recorded_outcome: `${w.units} units / A$${w.value} written off` });
  }
  for (const s of slow.slice(0, 2)) cases.push({ type: 'slow-mover', product_id: s.product_id, product: s.name,
    condition_detected: { day: s.day, detail: s.detail }, action_taken: { action: s.action },
    recorded_outcome: `${s.orders_after_flag} reorders placed after the flag` });
  if (cc.orders) {
    const ev = get(`SELECT e.day, e.product_id, e.detail, e.outcome FROM store_brain_events e
      WHERE e.run_id = @run AND e.condition = 'cash_constrained' ORDER BY e.event_id LIMIT 1`, p);
    cases.push({ type: 'cash-constraint', product_id: ev.product_id, condition_detected: ev, action_taken: null,
      recorded_outcome: `${cc.orders} orders cut back; ${cc.shortfall_units} units short` });
  }

  return {
    run_id: run.run_id,
    inventory_health: {
      stockouts: { product_days: counts.sold_out.events, products_affected: counts.sold_out.products,
        by_product: stockoutsByProduct, by_category: byCategory(stockoutsByProduct, ['stockout_days']) },
      low_stock: { events: counts.low_stock.events, products_affected: counts.low_stock.products, by_product: lowByProduct },
      lost_sales: lost,
      expiry: { units: writeoffByProduct.reduce((s, x) => s + x.units, 0), value: r2(writeoffByProduct.reduce((s, x) => s + x.value, 0)),
        by_product: writeoffByProduct, by_category: byCategory(writeoffByProduct, ['units', 'value']) },
      slow_moving: { count: slow.length, products: slow },
      replenishment: { orders: ord.orders, units_wanted: ord.wanted, units_ordered: ord.ordered, spend: r2(ord.spend),
        top_products_by_spend: ordersByProduct.slice(0, 10), by_category: byCategory(ordersByProduct, ['units', 'spend']) },
      closing_position: { units: closing.reduce((s, x) => s + x.units, 0), value: r2(closing.reduce((s, x) => s + x.value, 0)),
        products_at_zero_stock: closing.filter((x) => x.units === 0).map((x) => x.name),
        by_category: byCategory(closing, ['units', 'value']), top_by_value: [...closing].sort((a, b) => b.value - a.value).slice(0, 10) },
    },
    store_brain: {
      event_counts: counts,
      responses: {
        sold_out_with_same_day_order: { responded: soldOutResponded, of: soldOutOpen },
        sold_out_followed_by_another_sold_out: { count: soldOutRepeated, of: soldOutOpen },
        low_stock_with_same_day_order: { responded: lowResponded, of: lowOpen },
        expiry_warnings: { issued: warnedSet.size, ended_in_writeoff: [...warnedSet].filter((b) => expiredBatches.has(b)).length,
          writeoff_batches_without_warning: [...expiredBatches].filter((b) => !warnedSet.has(b)).length },
      },
      cash_constraint: { constrained_orders: cc.orders, shortfall_units: cc.shortfall_units,
        lowest_closing_cash: r2(lowCash.closing_cash), lowest_closing_cash_day: lowCash.day, lowest_cash_before_an_order: r2(minBefore),
        note: cc.orders === 0 ? 'No replenishment was constrained by insufficient operating cash.' : null },
      material_cases: cases,
    },
  };
}

/* ---------------- Part 3: written findings ---------------- */

function getFindings(run) {
  const rows = all('SELECT * FROM run_findings WHERE run_id = @run ORDER BY finding_no', { run: run.run_id });
  return { run_id: run.run_id, count: rows.length, findings: rows,
    note: rows.length ? null : 'No findings have been written for this run yet.' };
}

module.exports = { listRuns, getSetup, getProducts, getDeclaration, getPerformance, getOperations, getFindings };
