// server/sim/storeBrain.js - rule-based Store Brain
// Pure logic: it reads an observation of the closing store state and returns
// events (what it detected / did) and orders (what to replenish). It never
// touches the database; the engine records whatever it returns.

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const cents = (x) => Math.round(x * 100) / 100;
const sumQty = (batches) => batches.reduce((s, b) => s + b.qty, 0);

// z-score for a service level p (Abramowitz & Stegun 26.2.23), used for perishable safety stock
function zScore(p) {
  if (p <= 0.5) return 0;
  const t = Math.sqrt(-2 * Math.log(1 - Math.min(p, 0.999)));
  return t - (2.515517 + 0.802853 * t + 0.010328 * t * t) /
    (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t * t * t);
}

function createBrainMemory() {
  return { slowFlagged: new Set(), warnedBatches: new Set() };
}

// ---------- Start of day: remove expired stock ----------
// Rule: a batch with expiry_day <= today is removed from sale before customers arrive.
function expiryActions(products, day) {
  const actions = [];
  for (const p of products) {
    for (const b of p.batches) {
      if (b.expiry_day != null && b.expiry_day <= day && b.qty > 0) {
        const value = cents(b.qty * p.unit_cost);
        actions.push({
          product_id: p.product_id, batch_id: b.batch_id, qty: b.qty, value,
          event: {
            day, product_id: p.product_id, condition: 'expired_removed',
            action: 'removed from sale and written off',
            detail: `batch ${b.batch_id} reached expiry day ${b.expiry_day}; ${b.qty} units at cost A$${p.unit_cost.toFixed(2)}`,
            outcome: `write-off A$${value.toFixed(2)}`,
          },
        });
      }
    }
  }
  return actions;
}

// ---------- Demand forecast from observed history ----------
function forecast(cfg, hist, tomorrowIsWeekend) {
  const win = hist.slice(-cfg.lookbackDays);
  const dem = (h) => h.units + (cfg.useUnmetDemandSignal ? h.missed : 0);
  const avgRate = mean(win.map(dem));
  const same = win.filter((h) => !!h.is_weekend === tomorrowIsWeekend);
  const fTomorrow = same.length >= cfg.minSameTypeDays ? mean(same.map(dem)) : avgRate;
  let sigma = cfg.fallbackCV * fTomorrow;                 // too little history: assume typical variability
  if (same.length >= cfg.minObsForSigma) {
    const m = mean(same.map(dem));
    sigma = Math.sqrt(same.reduce((t, h) => t + (dem(h) - m) ** 2, 0) / (same.length - 1));
  }
  return { avgRate, fTomorrow, sigma, daysObserved: win.length };
}

// ---------- End of day review ----------
function reviewClosingState(cfg, obs, memory) {
  const { day, isLastDay, tomorrowIsWeekend } = obs;
  const events = [];
  const candidates = [];

  for (const p of obs.products) {
    const shortLife = p.is_perishable && p.shelf_life_days <= cfg.shortLifeMaxDays;
    const f = forecast(cfg, p.history, tomorrowIsWeekend);
    const onHand = sumQty(p.batches);
    const usable = sumQty(p.batches.filter((b) => b.expiry_day == null || b.expiry_day > day + 1));
    const cover = f.avgRate > 0 ? onHand / f.avgRate : (onHand > 0 ? Infinity : 0);
    const fmt = (x) => (Number.isFinite(x) ? x.toFixed(1) : 'n/a');
    const base = { day, product_id: p.product_id };

    // --- Sold out / low stock ---
    let sold = false, low = false;
    if (onHand === 0) {
      sold = true;
      events.push({ ...base, condition: 'sold_out',
        action: isLastDay ? 'reported (no order after Day 60)' : 'flagged unavailable; priority replenishment',
        detail: `closing stock 0; sold ${p.soldToday} today, ${p.missedToday} units of demand unmet; avg demand ${fmt(f.avgRate)}/day`,
        outcome: isLastDay ? 'no further orders possible' : 'replenishment decision follows' });
    } else {
      const threshold = shortLife ? cfg.lowStockCoverDaysShort : cfg.lowStockCoverDays;
      if (f.avgRate > 0 && cover < threshold) {
        low = true;
        events.push({ ...base, condition: 'low_stock',
          action: isLastDay ? 'reported (no order after Day 60)' : 'flagged for replenishment',
          detail: `closing stock ${onHand} = ${fmt(cover)} days cover < ${threshold}-day threshold (avg demand ${fmt(f.avgRate)}/day)`,
          outcome: isLastDay ? 'no further orders possible' : 'replenishment decision follows' });
      }
    }

    // --- Slow movers (long-life products only) ---
    let slow = false;
    if (!shortLife && day >= cfg.slowMinDay && onHand > 0 && (f.avgRate === 0 || cover > cfg.slowCoverDays)) slow = true;
    if (slow && !memory.slowFlagged.has(p.product_id)) {
      memory.slowFlagged.add(p.product_id);
      events.push({ ...base, condition: 'slow_mover',
        action: 'reorders held; flagged for manager review',
        detail: `stock ${onHand} = ${fmt(cover)} days cover > ${cfg.slowCoverDays}-day limit (avg demand ${fmt(f.avgRate)}/day)`,
        outcome: 'no reorder until cover falls below the reorder point' });
    } else if (!slow) {
      memory.slowFlagged.delete(p.product_id);
    }

    // --- Expiry warnings (FIFO: older batches sell first) ---
    if (p.is_perishable) {
      let ahead = 0;
      const sorted = [...p.batches].filter((b) => b.qty > 0).sort((a, b) => a.expiry_day - b.expiry_day);
      for (const b of sorted) {
        const daysLeft = b.expiry_day - 1 - day;            // selling days remaining after today
        if (daysLeft <= cfg.expiryWarningDays) {
          const expectedSales = f.avgRate * Math.max(0, daysLeft);
          const atRisk = Math.max(0, b.qty - Math.max(0, expectedSales - ahead));
          if (atRisk >= cfg.minAtRiskUnits && !memory.warnedBatches.has(b.batch_id)) {
            memory.warnedBatches.add(b.batch_id);
            events.push({ ...base, condition: 'expiry_warning',
              action: 'flagged for attention (no markdown rule in this model)',
              detail: `batch ${b.batch_id}: ${b.qty} units, ${Math.max(0, daysLeft)} selling day(s) left; expected to sell ${Math.round(Math.max(0, expectedSales - ahead))}; ~${Math.round(atRisk)} at risk`,
              outcome: `potential write-off ~A$${(atRisk * p.unit_cost).toFixed(2)}` });
          }
        }
        ahead += b.qty;
      }
    }

    // --- Replenishment need ---
    if (!isLastDay && !slow) {
      let need = 0, rule = '';
      if (shortLife) {
        const cd = Math.min(cfg.perishableMaxCoverDays,
          Math.max(cfg.perishableMinCoverDays, p.shelf_life_days * cfg.perishableShelfFraction));
        // Critical-ratio rule: an unsold unit is a write-off (lose the cost), a missed sale loses the margin.
        // The more profitable the product relative to its cost, the more safety stock it earns.
        const cr = (p.unit_price - p.unit_cost) / p.unit_price;
        const z = Math.min(cfg.maxSafetyZ, zScore(cr));
        const target = Math.max(0, Math.ceil(f.fTomorrow + (cd - 1) * f.avgRate + z * f.sigma * Math.sqrt(cd)));
        need = target - usable;
        rule = `short-life daily top-up: forecast ${fmt(f.fTomorrow)} tomorrow over ${cd.toFixed(1)} day(s), safety z=${z.toFixed(2)} x sd ${fmt(f.sigma)} (margin ${(100 * cr).toFixed(0)}%) -> target ${target}; sellable on hand ${usable}`;
      } else {
        const upTo = Math.min(cfg.orderUpToCoverDays,
          p.is_perishable ? p.shelf_life_days * cfg.orderUpToShelfFraction : Infinity);
        const trigger = onHand === 0 || (f.avgRate > 0 && cover <= cfg.reorderPointCoverDays);
        if (trigger) {
          const target = Math.ceil(cfg.safetyFactor * (f.fTomorrow + (upTo - 1) * f.avgRate));
          need = target - usable;
          rule = `reorder point hit (${fmt(cover)} days cover <= ${cfg.reorderPointCoverDays}); order up to ${upTo.toFixed(0)} days x demand x ${cfg.safetyFactor} = ${target} units; sellable on hand ${usable}`;
        }
      }
      if (need >= 1) candidates.push({ p, need, rule, cover: onHand === 0 ? -1 : cover, margin: (p.unit_price - p.unit_cost) * f.avgRate });
    }
  }

  // --- Allocate cash: most urgent first, then highest profit contribution ---
  candidates.sort((a, b) => a.cover - b.cover || b.margin - a.margin);
  let cash = cents(obs.cash - cfg.cashReserve);
  const orders = [];
  let ref = 0;
  for (const c of candidates) {
    const cashBefore = cash;
    const afford = Math.max(0, Math.floor(cash / c.p.unit_cost + 1e-9));
    const qty = Math.min(c.need, afford);
    const cost = cents(qty * c.p.unit_cost);
    cash = cents(cash - cost);
    const constrained = qty < c.need;
    const orderRef = ++ref;
    orders.push({ ref: orderRef, product_id: c.p.product_id, qty_wanted: c.need, qty_ordered: qty,
      unit_cost: c.p.unit_cost, total_cost: cost, cash_before: cashBefore,
      cash_constrained: constrained ? 1 : 0, reason: c.rule });
    events.push({ day, product_id: c.p.product_id, condition: 'replenishment',
      action: `order ${qty} units`, detail: c.rule, orderRef,
      outcome: `A$${cost.toFixed(2)} spent; arrives Day ${day + 1}` });
    if (constrained) {
      events.push({ day, product_id: c.p.product_id, condition: 'cash_constrained',
        action: qty === 0 ? 'order not placed' : 'order reduced to affordable quantity',
        detail: `wanted ${c.need} units (A$${(c.need * c.p.unit_cost).toFixed(2)}) but only A$${cashBefore.toFixed(2)} available`,
        outcome: `shortfall ${c.need - qty} units`, orderRef });
    }
  }
  return { events, orders };
}

module.exports = { createBrainMemory, expiryActions, reviewClosingState, forecast };
