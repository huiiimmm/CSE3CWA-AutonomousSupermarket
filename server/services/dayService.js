// server/services/dayService.js - Daily Report and drill-down (traceability) queries
const { all, get, r2, HttpError, parseDay } = require('./util');

function listDays(run) {
  return all(`SELECT d.day, d.weekday_name, d.is_weekend, d.special_event, s.customers, s.transactions, s.units_sold,
      s.revenue, s.writeoff_value, s.replenishment_spend, s.closing_cash, s.closing_inventory_value,
      (SELECT COUNT(*) FROM store_brain_events e WHERE e.run_id = d.run_id AND e.day = d.day AND e.condition = 'sold_out') sold_out_products,
      (SELECT COUNT(*) FROM store_brain_events e WHERE e.run_id = d.run_id AND e.day = d.day) brain_events
    FROM day_context d JOIN daily_summaries s ON s.run_id = d.run_id AND s.day = d.day
    WHERE d.run_id = @run ORDER BY d.day`, { run: run.run_id });
}

function getDay(run, dayParam) {
  const day = parseDay(dayParam);
  const p = { run: run.run_id, day };
  const context = get('SELECT * FROM day_context WHERE run_id = @run AND day = @day', p);
  if (!context) throw new HttpError(404, `No record for day ${day} in ${run.run_id}`);
  const summary = get('SELECT * FROM daily_summaries WHERE run_id = @run AND day = @day', p);

  // raw counts alongside the summary so the reader can see they agree
  const raw = get(`SELECT (SELECT COUNT(*) FROM customers WHERE run_id = @run AND day = @day) customers,
      (SELECT COUNT(*) FROM transactions WHERE run_id = @run AND day = @day) transactions,
      (SELECT COALESCE(SUM(total_amount),0) FROM transactions WHERE run_id = @run AND day = @day) revenue,
      (SELECT COALESCE(SUM(quantity),0) FROM transaction_items WHERE run_id = @run AND day = @day) units`, p);

  const hourly = all(`SELECT minute_of_day / 60 hour, COUNT(*) customers FROM customers
    WHERE run_id = @run AND day = @day GROUP BY hour ORDER BY hour`, p);
  const byCategory = all(`SELECT pr.category, SUM(i.quantity) units, SUM(i.line_total) revenue
    FROM transaction_items i JOIN run_products pr ON pr.run_id = i.run_id AND pr.product_id = i.product_id
    WHERE i.run_id = @run AND i.day = @day GROUP BY pr.category ORDER BY revenue DESC`, p)
    .map((c) => ({ ...c, revenue: r2(c.revenue) }));
  const topProducts = all(`SELECT i.product_id, pr.name, SUM(i.quantity) units, SUM(i.line_total) revenue
    FROM transaction_items i JOIN run_products pr ON pr.run_id = i.run_id AND pr.product_id = i.product_id
    WHERE i.run_id = @run AND i.day = @day GROUP BY i.product_id ORDER BY revenue DESC LIMIT 10`, p)
    .map((c) => ({ ...c, revenue: r2(c.revenue) }));
  const missed = all(`SELECT m.product_id, pr.name, SUM(m.units_missed) units_missed, SUM(m.lost_revenue) lost_revenue,
      SUM(CASE WHEN m.outcome = 'substituted' THEN 1 ELSE 0 END) substituted_cases
    FROM missed_demand m JOIN run_products pr ON pr.run_id = m.run_id AND pr.product_id = m.product_id
    WHERE m.run_id = @run AND m.day = @day GROUP BY m.product_id ORDER BY lost_revenue DESC`, p)
    .map((c) => ({ ...c, lost_revenue: r2(c.lost_revenue) }));
  const writeOffs = all(`SELECT e.expiry_id, e.product_id, pr.name, e.batch_id, e.quantity, e.value
    FROM expiry_events e JOIN run_products pr ON pr.run_id = e.run_id AND pr.product_id = e.product_id
    WHERE e.run_id = @run AND e.day = @day ORDER BY e.value DESC`, p);
  const ordersPlaced = all(`SELECT o.order_id, o.product_id, pr.name, o.qty_wanted, o.qty_ordered, o.total_cost, o.cash_constrained, o.arrival_day
    FROM replenishment_orders o JOIN run_products pr ON pr.run_id = o.run_id AND pr.product_id = o.product_id
    WHERE o.run_id = @run AND o.placed_day = @day ORDER BY o.total_cost DESC`, p);
  const ordersReceived = all(`SELECT o.order_id, o.product_id, pr.name, o.qty_ordered, o.total_cost, b.batch_id
    FROM replenishment_orders o JOIN run_products pr ON pr.run_id = o.run_id AND pr.product_id = o.product_id
    JOIN inventory_batches b ON b.order_id = o.order_id
    WHERE o.run_id = @run AND o.arrival_day = @day ORDER BY o.total_cost DESC`, p);
  const cash = all('SELECT entry_id, type, amount, balance_after, order_id FROM cash_ledger WHERE run_id = @run AND day = @day ORDER BY entry_id', p);
  const cashSummary = {
    opening_balance: r2(cash.length ? cash[0].balance_after - cash[0].amount : 0),
    sales: r2(cash.filter((c) => c.type === 'sales').reduce((s, c) => s + c.amount, 0)),
    replenishment_spend: r2(-cash.filter((c) => c.type === 'replenishment').reduce((s, c) => s + c.amount, 0)),
    closing_balance: r2(cash.length ? cash[cash.length - 1].balance_after : 0),
    entries: cash.length,
  };
  const events = all(`SELECT e.event_id, e.product_id, pr.name product, e.condition, e.action, e.detail, e.outcome, e.order_id
    FROM store_brain_events e LEFT JOIN run_products pr ON pr.run_id = e.run_id AND pr.product_id = e.product_id
    WHERE e.run_id = @run AND e.day = @day ORDER BY e.event_id`, p);
  const eventCounts = {};
  events.forEach((e) => (eventCounts[e.condition] = (eventCounts[e.condition] || 0) + 1));

  return {
    run_id: run.run_id, day, previous_day: day > 1 ? day - 1 : null, next_day: day < 60 ? day + 1 : null,
    context, summary, raw_totals: { ...raw, revenue: r2(raw.revenue) },
    customers_by_hour: hourly, sales_by_category: byCategory, top_products: topProducts,
    unmet_demand: missed, write_offs: writeOffs, orders_placed: ordersPlaced, orders_received: ordersReceived,
    cash: cashSummary, cash_entries: cash, store_brain: { counts: eventCounts, events },
  };
}

function listTransactions(run, dayParam, query = {}) {
  const day = parseDay(dayParam);
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
  const offset = Math.max(0, Number(query.offset) || 0);
  const p = { run: run.run_id, day };
  const total = get('SELECT COUNT(*) n FROM transactions WHERE run_id = @run AND day = @day', p).n;
  const rows = all(`SELECT t.txn_id, t.minute_of_day, t.total_amount, c.mission,
      (SELECT COALESCE(SUM(quantity),0) FROM transaction_items i WHERE i.txn_id = t.txn_id) units
    FROM transactions t JOIN customers c ON c.customer_id = t.customer_id
    WHERE t.run_id = @run AND t.day = @day ORDER BY t.txn_id LIMIT ${limit} OFFSET ${offset}`, p);
  return { run_id: run.run_id, day, total, limit, offset, transactions: rows };
}

function getTransaction(run, txnId) {
  const id = Number(txnId);
  const txn = get(`SELECT t.*, c.mission, c.customer_id FROM transactions t JOIN customers c ON c.customer_id = t.customer_id
    WHERE t.run_id = @run AND t.txn_id = @id`, { run: run.run_id, id });
  if (!txn) throw new HttpError(404, `Transaction ${txnId} not found in ${run.run_id}`);
  const items = all(`SELECT i.item_id, i.product_id, pr.name, i.quantity, i.unit_price, i.unit_cost, i.line_total,
      i.batch_id, b.source batch_source, b.received_day, b.expiry_day, b.order_id
    FROM transaction_items i JOIN run_products pr ON pr.run_id = i.run_id AND pr.product_id = i.product_id
    JOIN inventory_batches b ON b.batch_id = i.batch_id WHERE i.txn_id = @id ORDER BY i.item_id`, { id });
  return { run_id: run.run_id, transaction: txn, items,
    check: { sum_of_lines: r2(items.reduce((s, i) => s + i.line_total, 0)), recorded_total: txn.total_amount } };
}

function getProductHistory(run, productId) {
  const p = { run: run.run_id, pid: productId };
  const product = get('SELECT * FROM run_products WHERE run_id = @run AND product_id = @pid', p);
  if (!product) throw new HttpError(404, `Product ${productId} not found in ${run.run_id}`);

  const dayRows = all(`SELECT day, type, SUM(qty_change) q FROM inventory_movements
    WHERE run_id = @run AND product_id = @pid GROUP BY day, type`, p);
  const missed = all(`SELECT day, SUM(units_missed) q FROM missed_demand WHERE run_id = @run AND product_id = @pid GROUP BY day`, p);
  let stock = 0;
  const daily = Array.from({ length: 60 }, (_, i) => {
    const day = i + 1;
    const q = (t) => dayRows.filter((r) => r.day === day && r.type === t).reduce((s, r) => s + r.q, 0);
    const opening = q('opening'), received = q('received'), sold = -q('sold'), expired = -q('expired');
    stock += opening + received - sold - expired;
    return { day, opening, received, sold, expired, unmet_demand: missed.find((m) => m.day === day)?.q || 0, closing_stock: stock };
  });
  const sum = (k) => daily.reduce((s, d) => s + d[k], 0);
  return {
    run_id: run.run_id, product,
    totals: { opening: sum('opening'), received: sum('received'), sold: sum('sold'), expired: sum('expired'),
      closing: stock, unmet_demand: sum('unmet_demand') },
    daily,
    batches: all('SELECT batch_id, source, received_day, expiry_day, qty_received, unit_cost, order_id FROM inventory_batches WHERE run_id = @run AND product_id = @pid ORDER BY batch_id', p),
    orders: all('SELECT order_id, placed_day, arrival_day, qty_wanted, qty_ordered, total_cost, cash_constrained FROM replenishment_orders WHERE run_id = @run AND product_id = @pid ORDER BY order_id', p),
    write_offs: all('SELECT day, batch_id, quantity, value FROM expiry_events WHERE run_id = @run AND product_id = @pid ORDER BY day', p),
    store_brain_events: all(`SELECT event_id, day, condition, action, detail, outcome, order_id FROM store_brain_events
      WHERE run_id = @run AND product_id = @pid ORDER BY event_id`, p),
  };
}

function getOrder(run, orderId) {
  const id = Number(orderId);
  const order = get(`SELECT o.*, pr.name product FROM replenishment_orders o
    JOIN run_products pr ON pr.run_id = o.run_id AND pr.product_id = o.product_id
    WHERE o.run_id = @run AND o.order_id = @id`, { run: run.run_id, id });
  if (!order) throw new HttpError(404, `Order ${orderId} not found in ${run.run_id}`);
  return {
    run_id: run.run_id, order,
    triggering_events: all('SELECT event_id, day, condition, action, detail, outcome FROM store_brain_events WHERE order_id = @id ORDER BY event_id', { id }),
    batch_received: get('SELECT batch_id, received_day, expiry_day, qty_received, unit_cost FROM inventory_batches WHERE order_id = @id', { id }) || null,
    cash_entry: get('SELECT entry_id, day, amount, balance_after FROM cash_ledger WHERE order_id = @id', { id }) || null,
  };
}

module.exports = { listDays, getDay, listTransactions, getTransaction, getProductHistory, getOrder };
