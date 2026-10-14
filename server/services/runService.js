// server/services/runService.js
// Creates a run (freezes configuration) and executes it (writes 60 days of history).
const crypto = require('crypto');
const db = require('../db');
const baseConfig = require('../sim/modelConfig');
const { makeRng } = require('../sim/rng');
const { buildDayContext, generateCustomers } = require('../sim/demand');
const brain = require('../sim/storeBrain');
const seedFile = require('../data/products.json');   // used ONLY for popularity weights

const DAYS = 60;
const cents = (x) => Math.round(x * 100) / 100;
const sumQty = (batches) => batches.reduce((s, b) => s + b.qty, 0);

/* ------------------------------------------------------------------ */
/* Part A - create the run                                             */
/* ------------------------------------------------------------------ */

function loadCatalogue() {
  const popularity = Object.fromEntries(seedFile.map((p) => [p.product_id, p.popularity]));
  return db.prepare('SELECT * FROM products ORDER BY product_id').all().map((p) => {
    if (popularity[p.product_id] == null) throw new Error(`No popularity weight for ${p.product_id}`);
    return { ...p, popularity: popularity[p.product_id] };
  });
}

function validateCatalogue(products, budget) {
  const errors = [];
  if (!products.length) errors.push('product catalogue is empty');
  const total = products.reduce((s, p) => s + p.unit_cost * p.initial_qty, 0);
  if (total > budget) errors.push(`opening inventory A$${total.toFixed(2)} exceeds budget A$${budget}`);
  for (const p of products) {
    if (p.unit_price <= p.unit_cost) errors.push(`${p.product_id}: price must exceed cost`);
    if (p.is_perishable && !p.shelf_life_days) errors.push(`${p.product_id}: perishable needs shelf life`);
  }
  if (errors.length) throw new Error('Catalogue validation failed: ' + errors.join('; '));
  return total;
}

function newRunId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `RUN-${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

function createRun({ seed, openingCash = 15000, inventoryBudget = 40000 } = {}) {
  const products = loadCatalogue();
  validateCatalogue(products, inventoryBudget);              // Step 1: stop before writing anything

  const runId = newRunId();                                  // Step 2
  const runSeed = seed ?? Math.floor(Math.random() * 1e9);
  const config = JSON.parse(JSON.stringify({                 // frozen copy of every assumption
    ...baseConfig,
    randomSeed: runSeed,
    productPopularity: Object.fromEntries(products.map((p) => [p.product_id, p.popularity])),
  }));

  db.transaction(() => {                                     // Steps 3-6, committed on their own
    db.prepare(`INSERT INTO runs (run_id, status, inventory_budget, opening_cash, random_seed)
                VALUES (?, 'created', ?, ?, ?)`).run(runId, inventoryBudget, openingCash, runSeed);
    db.prepare('INSERT INTO run_config (run_id, config_json) VALUES (?, ?)').run(runId, JSON.stringify(config));
    const insP = db.prepare(`INSERT INTO run_products
      (run_id, product_id, name, category, unit_cost, unit_price, opening_qty, is_perishable, shelf_life_days)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    for (const p of products)
      insP.run(runId, p.product_id, p.name, p.category, p.unit_cost, p.unit_price,
               p.initial_qty, p.is_perishable, p.shelf_life_days);
    db.prepare("UPDATE runs SET status = 'running' WHERE run_id = ?").run(runId);
  })();

  return { runId, seed: runSeed, openingCash, products, config };
}

/* ------------------------------------------------------------------ */
/* Part B - execute the run (called inside ONE transaction)            */
/* ------------------------------------------------------------------ */

function executeRun({ runId, seed, openingCash, products, config }) {
  const B = config.storeBrain;
  const rng = makeRng(seed);                                 // customers and demand
  const rngSub = makeRng(`${seed}-substitution`);            // substitution choices (separate stream)
  const memory = brain.createBrainMemory();

  // one prepared INSERT per table; each returns the new row id
  const insert = (table, cols) => {
    const st = db.prepare(`INSERT INTO ${table} (run_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`);
    return (...v) => st.run(runId, ...v).lastInsertRowid;
  };
  const insBatch = insert('inventory_batches', ['product_id', 'source', 'received_day', 'expiry_day', 'qty_received', 'unit_cost', 'order_id']);
  const insMove = insert('inventory_movements', ['day', 'product_id', 'batch_id', 'type', 'qty_change', 'txn_id']);
  const insCash = insert('cash_ledger', ['day', 'type', 'amount', 'balance_after', 'order_id']);
  const insCtx = insert('day_context', ['day', 'weekday_name', 'is_weekend', 'day_type_multiplier', 'noise_multiplier', 'special_event', 'event_multiplier', 'expected_customers']);
  const insCust = insert('customers', ['day', 'minute_of_day', 'mission', 'purchased']);
  const insTxn = insert('transactions', ['day', 'customer_id', 'minute_of_day', 'total_amount']);
  const insItem = insert('transaction_items', ['txn_id', 'day', 'product_id', 'batch_id', 'quantity', 'unit_price', 'unit_cost', 'line_total']);
  const insMissed = insert('missed_demand', ['day', 'customer_id', 'product_id', 'units_missed', 'lost_revenue', 'reason', 'outcome']);
  const insExpiry = insert('expiry_events', ['day', 'product_id', 'batch_id', 'quantity', 'value']);
  const insOrder = insert('replenishment_orders', ['product_id', 'placed_day', 'arrival_day', 'qty_wanted', 'qty_ordered', 'unit_cost', 'total_cost', 'cash_before', 'cash_constrained', 'reason']);
  const insEvent = insert('store_brain_events', ['day', 'product_id', 'condition', 'action', 'detail', 'outcome', 'order_id']);
  const insSummary = insert('daily_summaries', ['day', 'customers', 'transactions', 'units_sold', 'revenue', 'cogs', 'gross_profit', 'writeoff_value', 'replenishment_spend', 'closing_cash', 'closing_inventory_value']);

  // in-memory working copy of the store (the database is the permanent record)
  const byId = Object.fromEntries(products.map((p) => [p.product_id, p]));
  const byCat = {};
  products.forEach((p) => (byCat[p.category] ||= []).push(p));
  const stock = Object.fromEntries(products.map((p) => [p.product_id, []]));
  const hist = Object.fromEntries(products.map((p) => [p.product_id, []]));
  const expiryDay = (p, receivedDay) => (p.is_perishable ? receivedDay + p.shelf_life_days : null);

  // Step 8 - opening position
  let cash = openingCash;
  insCash(1, 'opening', openingCash, cash, null);
  for (const p of products) {
    if (p.initial_qty > 0) {
      const qty = p.initial_qty;
      const batchId = insBatch(p.product_id, 'opening', 1, expiryDay(p, 1), qty, p.unit_cost, null);
      insMove(1, p.product_id, batchId, 'opening', qty, null);
      stock[p.product_id].push({ batch_id: batchId, qty, unit_cost: p.unit_cost, expiry_day: expiryDay(p, 1) });
    }
  }

  const T = { customers: 0, txns: 0, units: 0, revenue: 0, cogs: 0, writeoff: 0, spend: 0 };
  let pending = [];                                          // orders placed yesterday, arriving today

  // Step 9 - the 60-day loop
  for (let day = 1; day <= DAYS; day++) {
    // 1. receive yesterday's orders
    for (const o of pending) {
      const p = byId[o.product_id];
      const batchId = insBatch(o.product_id, 'replenishment', day, expiryDay(p, day), o.qty, o.unit_cost, o.order_id);
      insMove(day, o.product_id, batchId, 'received', o.qty, null);
      stock[o.product_id].push({ batch_id: batchId, qty: o.qty, unit_cost: o.unit_cost, expiry_day: expiryDay(p, day) });
    }
    pending = [];

    // 2. expiry - the Brain decides what is removed, the engine records it
    let dayWriteoff = 0;
    const snapshot = products.map((p) => ({ ...p, batches: stock[p.product_id] }));
    for (const a of brain.expiryActions(snapshot, day)) {
      stock[a.product_id] = stock[a.product_id].filter((b) => b.batch_id !== a.batch_id);
      insExpiry(day, a.product_id, a.batch_id, a.qty, a.value);
      insMove(day, a.product_id, a.batch_id, 'expired', -a.qty, null);
      insEvent(day, a.product_id, a.event.condition, a.event.action, a.event.detail, a.event.outcome, null);
      dayWriteoff = cents(dayWriteoff + a.value);
    }

    // 3. day context
    const ctx = buildDayContext(config, day, rng);
    insCtx(day, ctx.weekday_name, ctx.is_weekend, ctx.day_type_multiplier, ctx.noise_multiplier,
           ctx.special_event, ctx.event_multiplier, ctx.expected_customers);

    // 4. customers
    const today = Object.fromEntries(products.map((p) => [p.product_id, { units: 0, missed: 0 }]));
    let dayCust = 0, dayTxns = 0, dayUnits = 0, dayRev = 0, dayCogs = 0;

    for (const c of generateCustomers(config, products, ctx, rng)) {
      dayCust++;
      const lines = [], missed = [];
      const inBasket = new Set(c.wants.map((w) => w.product_id));

      const take = (pid, qty) => {                           // first-in, first-out
        let left = qty, got = 0;
        for (const b of stock[pid]) {
          if (!left) break;
          const t = Math.min(b.qty, left);
          if (t > 0) { b.qty -= t; left -= t; got += t; lines.push({ pid, batch_id: b.batch_id, qty: t, unit_cost: b.unit_cost }); }
        }
        stock[pid] = stock[pid].filter((b) => b.qty > 0);
        today[pid].units += got;
        return got;
      };

      for (const w of c.wants) {
        const got = take(w.product_id, w.qty);
        const miss = w.qty - got;
        if (miss > 0) {
          let subUnits = 0;
          if (rngSub.next() < config.stockoutBehaviour.substituteProbability) {
            const opts = byCat[w.category].filter((p) => !inBasket.has(p.product_id) && sumQty(stock[p.product_id]) > 0);
            if (opts.length) {
              const sub = rngSub.weighted(opts, opts.map((p) => p.popularity));
              inBasket.add(sub.product_id);
              subUnits = take(sub.product_id, miss);
            }
          }
          today[w.product_id].missed += miss;
          missed.push({ pid: w.product_id, units: miss, reason: got === 0 ? 'sold_out' : 'partial_stock',
            lost: cents((miss - subUnits) * byId[w.product_id].unit_price),
            outcome: subUnits > 0 ? 'substituted' : 'lost' });
        }
      }

      // write order matters: customer -> transaction -> items/movements -> missed demand
      const customerId = insCust(day, c.minute_of_day, c.mission, lines.length ? 1 : 0);
      if (lines.length) {
        const priced = lines.map((l) => ({ ...l, price: byId[l.pid].unit_price, total: cents(l.qty * byId[l.pid].unit_price) }));
        const total = cents(priced.reduce((s, l) => s + l.total, 0));
        const txnId = insTxn(day, customerId, c.minute_of_day, total);
        for (const l of priced) {
          insItem(txnId, day, l.pid, l.batch_id, l.qty, l.price, l.unit_cost, l.total);
          insMove(day, l.pid, l.batch_id, 'sold', -l.qty, txnId);
          dayUnits += l.qty; dayCogs += l.qty * l.unit_cost;
        }
        dayTxns++; dayRev = cents(dayRev + total);
      }
      for (const m of missed) insMissed(day, customerId, m.pid, m.units, m.lost, m.reason, m.outcome);
    }

    // 5. book the day's revenue BEFORE the Brain orders
    cash = cents(cash + dayRev);
    insCash(day, 'sales', dayRev, cash, null);
    for (const p of products) hist[p.product_id].push({ day, units: today[p.product_id].units,
      missed: today[p.product_id].missed, is_weekend: ctx.is_weekend });

    // 6. Store Brain end-of-day review
    const tomorrowIsWeekend = [0, 6].includes((config.arrivals.startWeekday + day) % 7);
    const out = brain.reviewClosingState(B, {
      day, isLastDay: day === DAYS, tomorrowIsWeekend, cash,
      products: products.map((p) => ({ ...p, batches: stock[p.product_id], history: hist[p.product_id],
        soldToday: today[p.product_id].units, missedToday: today[p.product_id].missed })),
    }, memory);

    // 7. place orders (cost leaves cash now; stock arrives tomorrow)
    const orderIds = {};
    let daySpend = 0;
    for (const o of out.orders) {
      if (o.total_cost > cash + 1e-6) throw new Error(`Order exceeds cash on day ${day}`);
      const id = insOrder(o.product_id, day, day + 1, o.qty_wanted, o.qty_ordered, o.unit_cost,
                          o.total_cost, o.cash_before, o.cash_constrained, o.reason);
      orderIds[o.ref] = id;
      if (o.total_cost > 0) {
        cash = cents(cash - o.total_cost); daySpend = cents(daySpend + o.total_cost);
        insCash(day, 'replenishment', -o.total_cost, cash, id);
      }
      if (o.qty_ordered > 0) pending.push({ order_id: id, product_id: o.product_id, qty: o.qty_ordered, unit_cost: o.unit_cost });
    }
    for (const e of out.events)
      insEvent(e.day, e.product_id ?? null, e.condition, e.action, e.detail, e.outcome ?? null,
               e.orderRef ? orderIds[e.orderRef] : null);

    // 8. daily summary
    const invValue = cents(products.reduce((s, p) => s + sumQty(stock[p.product_id]) * p.unit_cost, 0));
    insSummary(day, dayCust, dayTxns, dayUnits, dayRev, cents(dayCogs), cents(dayRev - dayCogs),
               dayWriteoff, daySpend, cash, invValue);
    T.customers += dayCust; T.txns += dayTxns; T.units += dayUnits; T.revenue = cents(T.revenue + dayRev);
    T.cogs += dayCogs; T.writeoff = cents(T.writeoff + dayWriteoff); T.spend = cents(T.spend + daySpend);
    T.closingCash = cash; T.closingInventory = invValue;
  }

  // Step 10 - complete (same transaction as the history)
  db.prepare("UPDATE runs SET status = 'completed', completed_at = datetime('now') WHERE run_id = ?").run(runId);
  return { run_id: runId, status: 'completed', seed, ...T, cogs: cents(T.cogs), gross_profit: cents(T.revenue - T.cogs) };
}

/* ------------------------------------------------------------------ */
/* Public entry points                                                 */
/* ------------------------------------------------------------------ */

function createAndRunSimulation(options = {}) {
  const t0 = Date.now();
  const run = createRun(options);                            // committed: configuration exists
  try {
    const summary = db.transaction(() => executeRun(run))(); // all-or-nothing history
    return { ...summary, seconds: (Date.now() - t0) / 1000 };
  } catch (err) {
    db.prepare("UPDATE runs SET status = 'failed', completed_at = datetime('now') WHERE run_id = ?").run(run.runId);
    err.runId = run.runId;
    throw err;
  }
}

function markSubmitted(runId) {
  const run = db.prepare('SELECT status FROM runs WHERE run_id = ?').get(runId);
  if (!run) throw new Error('Run not found');
  if (run.status !== 'completed') throw new Error('Only a completed run can be the Submitted Run');
  db.transaction(() => {
    db.prepare('UPDATE runs SET is_submitted = 0 WHERE is_submitted = 1').run();
    db.prepare('UPDATE runs SET is_submitted = 1 WHERE run_id = ?').run(runId);
  })();
}

module.exports = { createAndRunSimulation, createRun, executeRun, markSubmitted };
