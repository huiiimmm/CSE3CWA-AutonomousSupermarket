// server/sim/testBrain.js - in-memory 60-day run to test the Store Brain (no database)
// usage: node sim/testBrain.js [seed] [openingCash]   (optional env BRAIN_RESERVE=7000 to stress the cash rule)
const path = require('path');
const config = require('./modelConfig');
const { makeRng } = require('./rng');
const { buildDayContext, generateCustomers } = require('./demand');
const brain = require('./storeBrain');
const products = require(path.join('..', 'data', 'products.json'));

const seed = process.argv[2] || config.randomSeed;
const OPENING_CASH = Number(process.argv[3] || 15000);
const rng = makeRng(seed);              // customers and demand
const rngSub = makeRng(seed + '-substitution'); // substitution choices (separate stream, so Brain changes never alter the customers)
const B = { ...config.storeBrain, ...(process.env.BRAIN_RESERVE ? { cashReserve: Number(process.env.BRAIN_RESERVE) } : {}) };
const cents = (x) => Math.round(x * 100) / 100;

// ---- world state ----
const byId = Object.fromEntries(products.map((p) => [p.product_id, p]));
const stock = Object.fromEntries(products.map((p) => [p.product_id, []]));
const hist = Object.fromEntries(products.map((p) => [p.product_id, []]));
const byCat = {};
for (const p of products) (byCat[p.category] ||= []).push(p);
let batchSeq = 0, cash = OPENING_CASH, pending = [];
const memory = brain.createBrainMemory();
const T = { revenue: 0, cogs: 0, units: 0, received: 0, opening: 0, expired: 0, expiredValue: 0, spend: 0,
  customers: 0, txns: 0, lostRev: 0, subs: 0, lostUnits: 0 };
const events = [], orders = [], expByProd = {}, soByProd = {}, soldByProd = {}, rcvByProd = {}, expUnitsByProd = {};
const sumQty = (pid) => stock[pid].reduce((s, b) => s + b.qty, 0);
const addBatch = (pid, qty, day, src) => {
  const p = byId[pid];
  stock[pid].push({ batch_id: ++batchSeq, qty, received_day: day, unit_cost: p.unit_cost,
    expiry_day: p.is_perishable ? day + p.shelf_life_days : null });
  if (src === 'opening') { T.opening += qty; } else { T.received += qty; rcvByProd[pid] = (rcvByProd[pid] || 0) + qty; }
};
const sell = (pid, qty) => {                                 // FIFO
  let left = qty;
  for (const b of stock[pid]) { const t = Math.min(b.qty, left); b.qty -= t; left -= t; if (!left) break; }
  stock[pid] = stock[pid].filter((b) => b.qty > 0);
};

products.forEach((p) => addBatch(p.product_id, p.initial_qty, 1, 'opening'));
const openingCost = products.reduce((s, p) => s + p.initial_qty * p.unit_cost, 0);

const t0 = Date.now();
for (let day = 1; day <= 60; day++) {
  // 1. receive yesterday's orders
  for (const o of pending.filter((x) => x.arrival === day)) if (o.qty > 0) addBatch(o.pid, o.qty, day, 'rcv');
  pending = pending.filter((x) => x.arrival !== day);

  // 2. expiry
  const snap = products.map((p) => ({ ...p, batches: stock[p.product_id] }));
  for (const a of brain.expiryActions(snap, day)) {
    const b = stock[a.product_id].find((x) => x.batch_id === a.batch_id);
    b.qty = 0; stock[a.product_id] = stock[a.product_id].filter((x) => x.qty > 0);
    T.expired += a.qty; T.expiredValue += a.value;
    expByProd[a.product_id] = (expByProd[a.product_id] || 0) + a.value;
    expUnitsByProd[a.product_id] = (expUnitsByProd[a.product_id] || 0) + a.qty;
    events.push(a.event);
  }

  // 3. customers
  const ctx = buildDayContext(config, day, rng);
  const todays = Object.fromEntries(products.map((p) => [p.product_id, { units: 0, missed: 0 }]));
  let dayRev = 0;
  for (const c of generateCustomers(config, products, ctx, rng)) {
    T.customers++;
    const lines = [], inBasket = new Set(c.wants.map((w) => w.product_id));
    const take = (pid, qty) => { const t = Math.min(qty, sumQty(pid)); if (t) { lines.push({ pid, t }); sell(pid, t); } return t; };
    for (const w of c.wants) {
      const got = take(w.product_id, w.qty);
      const miss = w.qty - got;
      if (miss > 0) {
        todays[w.product_id].missed += miss;
        let outcome = 'lost';
        if (rngSub.next() < config.stockoutBehaviour.substituteProbability) {
          const opts = byCat[w.category].filter((p) => !inBasket.has(p.product_id) && sumQty(p.product_id) > 0);
          if (opts.length) {
            const sub = rngSub.weighted(opts, opts.map((p) => p.popularity));
            const g2 = take(sub.product_id, miss); inBasket.add(sub.product_id);
            if (g2) { outcome = 'substituted'; T.subs++; }
          }
        }
        if (outcome === 'lost') { T.lostRev += miss * byId[w.product_id].unit_price; T.lostUnits += miss; }
        else { T.lostRev += 0; }
      }
    }
    if (lines.length) {
      T.txns++;
      for (const l of lines) {
        const p = byId[l.pid];
        todays[l.pid].units += l.t; dayRev += l.t * p.unit_price;
        T.units += l.t; T.cogs += l.t * p.unit_cost; soldByProd[l.pid] = (soldByProd[l.pid] || 0) + l.t;
      }
    }
  }
  T.revenue += dayRev; cash = cents(cash + dayRev);
  for (const p of products) hist[p.product_id].push({ day, units: todays[p.product_id].units,
    missed: todays[p.product_id].missed, is_weekend: ctx.is_weekend });

  // 4. Store Brain end-of-day review
  const tomorrowIsWeekend = [0, 6].includes((config.arrivals.startWeekday + day) % 7);
  const obs = { day, isLastDay: day === 60, tomorrowIsWeekend, cash,
    products: products.map((p) => ({ ...p, batches: stock[p.product_id], history: hist[p.product_id],
      soldToday: todays[p.product_id].units, missedToday: todays[p.product_id].missed })) };
  const out = brain.reviewClosingState(B, obs, memory);
  out.events.forEach((e) => { events.push(e); if (e.condition === 'sold_out') soByProd[e.product_id] = (soByProd[e.product_id] || 0) + 1; });
  for (const o of out.orders) {
    if (o.total_cost > o.cash_before + 1e-6) throw new Error('order exceeds cash!');
    cash = cents(cash - o.total_cost); T.spend += o.total_cost; orders.push({ ...o, day });
    pending.push({ pid: o.product_id, qty: o.qty_ordered, arrival: day + 1 });
  }
  if (cash < 0) throw new Error('negative cash on day ' + day);
}
const ms = Date.now() - t0;

// ---- report ----
const closingInv = products.reduce((s, p) => s + sumQty(p.product_id) * p.unit_cost, 0);
const cnt = {}; events.forEach((e) => (cnt[e.condition] = (cnt[e.condition] || 0) + 1));
const f = (x) => 'A$' + Math.round(x).toLocaleString();
console.log(`seed ${seed} | opening cash ${f(OPENING_CASH)} | opening inventory ${f(openingCost)} | ${ms} ms`);
console.log(`customers ${T.customers} | transactions ${T.txns} | units ${T.units} | revenue ${f(T.revenue)} | COGS ${f(T.cogs)} | GP ${f(T.revenue - T.cogs)} (${(100 * (1 - T.cogs / T.revenue)).toFixed(1)}%)`);
console.log(`write-off ${T.expired} units ${f(T.expiredValue)} (${(100 * T.expiredValue / T.cogs).toFixed(1)}% of COGS) | lost sales ${T.lostUnits} units ${f(T.lostRev)} | substitutions ${T.subs}`);
console.log(`replenishment orders ${orders.length} | spend ${f(T.spend)} | closing cash ${f(cash)} | closing inventory ${f(closingInv)}`);
console.log('event counts:', JSON.stringify(cnt));
const top = (o, n = 6) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${byId[k].name} ${Math.round(v)}`).join('; ');
console.log('write-off value by product:', top(expByProd));
console.log('stockout days by product:', top(soByProd));
console.log('slow movers flagged:', events.filter((e) => e.condition === 'slow_mover').map((e) => `D${e.day} ${byId[e.product_id].name}`).join('; ') || 'none');
console.log('cash constrained orders:', orders.filter((o) => o.cash_constrained).length);

// ---- reconciliation self-check ----
let ok = true;
for (const p of products) {
  const pid = p.product_id;
  const open = p.initial_qty, rcv = rcvByProd[pid] || 0, sold = soldByProd[pid] || 0, exp = expUnitsByProd[pid] || 0;
  if (open + rcv - sold - exp !== sumQty(pid)) { ok = false; console.log('INVENTORY MISMATCH', pid); }
}
const cashCheck = cents(OPENING_CASH + T.revenue - T.spend);
console.log('inventory reconciles:', ok, '| cash reconciles:', Math.abs(cashCheck - cash) < 0.05);
const show = (c, n = 2) => events.filter((e) => e.condition === c).slice(0, n)
  .forEach((e) => console.log(`  [${c}] D${e.day} ${e.product_id}: ${e.action} | ${e.detail} | ${e.outcome}`));
console.log('sample events:'); ['sold_out', 'low_stock', 'expiry_warning', 'expired_removed', 'slow_mover', 'replenishment', 'cash_constrained'].forEach((c) => show(c));
