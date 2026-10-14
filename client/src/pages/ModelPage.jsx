// Setup, product data and the Model Declaration (generated from the run's frozen configuration).
import { useState } from 'react';
import { Load, KV, Table, money, num, nice } from '../ui';

const pct = (x) => `${Math.round(100 * x)}%`;
const mean = (t) => Object.entries(t).reduce((s, [n, p]) => s + Number(n) * p, 0);

export function ModelView({ setup, products, declaration }) {
  const [cat, setCat] = useState('All');
  const cfg = declaration.config, a = cfg.arrivals, b = cfg.storeBrain, pop = cfg.productPopularity || {};
  const rows = products.filter((p) => cat === 'All' || p.category === cat).map((p) => ({ ...p, w: pop[p.product_id] }));
  const peaks = a.hourlyShare.weekday.map((v, h) => [v, h]).sort((x, y) => y[0] - x[0]).slice(0, 4).map((x) => x[1]).sort((x, y) => x - y);
  return (
    <>
      <h2>Setup</h2>
      <KV rows={[
        ['Run ID', declaration.run_id], ['Random seed', declaration.random_seed],
        ['Opening inventory budget (max)', money(setup.inventory_budget)], ['Opening inventory cost', money(setup.opening_inventory_cost, 2)],
        ['Opening operating cash', money(setup.opening_cash)], ['Products', `${setup.products} (${setup.perishable_products} perishable)`],
      ]} />

      <h3>Product data</h3>
      <label>Category <select value={cat} onChange={(e) => setCat(e.target.value)}><option>All</option>{setup.categories.map((c) => <option key={c.category}>{c.category}</option>)}</select></label>
      <Table cols={[
        ['ID', 'product_id'], ['Product (pack size)', 'name'], ['Category', 'category'],
        ['Cost', (r) => money(r.unit_cost, 2), 'r'], ['Price', (r) => money(r.unit_price, 2), 'r'], ['Opening qty', (r) => num(r.opening_qty), 'r'],
        ['Shelf life', (r) => (r.shelf_life_days ? `${r.shelf_life_days} d` : 'non-perishable')], ['Demand weight', 'w', 'r'],
      ]} rows={rows} />

      <h2>Model Declaration</h2>
      <p className="muted">Generated from the configuration frozen when this run began. Pre-operational prototype: real operating data would be needed to validate and calibrate it.</p>

      <h3>1. Customer activity</h3>
      <p>Each day starts at {num(a.baseCustomersPerDay)} customers, times {a.weekdayMultiplier} on weekdays or {a.weekendMultiplier} on weekends, times random daily noise (sd {pct(a.dailyNoiseSd)}),
        times an occasional event ({a.specialEvents.map((e) => `${e.name.toLowerCase()} x${e.multiplier}, ${pct(e.probPerDay)} of days`).join('; ')}). Day 1 is a Monday; the store is open 24 hours.
        Customers are spread over the hours with a Poisson draw; weekday peaks are around {peaks.map((h) => `${h}:00`).join(', ')}, weekends are flatter.</p>

      <h3>2. Shopping behaviour and product demand</h3>
      <p>Each customer gets a mission. The mix of missions depends on the time of day, and weekends shift towards top-up and household shopping. A mission sets the number of
        different products and the favoured categories; products within a category are chosen by demand weight; quantity is mostly 1. If an item is unavailable the customer
        substitutes within the category with probability {pct(cfg.stockoutBehaviour.substituteProbability)}, otherwise the demand is lost and recorded.</p>
      <Table cols={[['Mission', (r) => nice(r.m)], ['Products per basket', 'items', 'r'], ['Main categories', 'cats']]}
        rows={cfg.missionOrder.map((m) => ({ m, items: mean(cfg.missions[m].distinctItems).toFixed(1),
          cats: Object.entries(cfg.missions[m].categoryWeights).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([c, w]) => `${c} ${pct(w)}`).join(', ') }))} />

      <h3>3. Perishable stock</h3>
      <p>Stock is held in batches with a received day and expiry day (received + shelf life). A batch received on day r with shelf life L is sold on days r to r+L-1 and
        written off at cost before customers arrive on day r+L. Sales take the oldest batch first; expired stock is never sold. Opening stock counts as received on Day 1.</p>

      <h3>4. How the Store Brain detects conditions</h3>
      <p>It forecasts each product from the last {b.lookbackDays} days (weekday days for a weekday, weekend days for a weekend{b.useUnmetDemandSignal ? '; unmet demand counts as demand' : ''}).</p>
      <ul>
        <li>Sold out: closing stock is zero.</li>
        <li>Low stock: less than {b.lowStockCoverDays} days of cover (long-life products; short-life perishables are run near zero by design, so only sold-out is alerted).</li>
        <li>Expiry: expired batches are removed; a batch with {b.expiryWarningDays} or fewer selling days left is flagged when {b.minAtRiskUnits}+ units are unlikely to sell. No markdowns.</li>
        <li>Slow-moving: from Day {b.slowMinDay}, more than {b.slowCoverDays} days of cover (long-life products). Reorders are held and the product flagged.</li>
      </ul>

      <h3>5. Replenishment under the cash constraint</h3>
      <p>Orders are placed after close; the cost leaves cash immediately and stock arrives before customers the next day (one-day lead time). No order is placed after Day 60.</p>
      <ul>
        <li>Long-life products: when cover falls to {b.reorderPointCoverDays} days, order up to {b.orderUpToCoverDays} days of demand (with a {pct(b.safetyFactor - 1)} buffer).</li>
        <li>Short-life perishables: topped up daily to forecast demand plus safety stock that grows with margin (a missed sale loses the margin, an unsold unit loses its cost).</li>
        <li>Cash: orders are ranked by urgency, then profit contribution; each is filled in full if affordable, otherwise cut back and recorded as cash-constrained.</li>
      </ul>

      <h3>6. Other assumptions</h3>
      <ul>
        <li>Rent, labour, utilities, hardware and overheads are outside the model, so gross profit is not store profit.</li>
        <li>Prices and costs are constant; no discounts, theft or supplier limits; customers are independent.</li>
        <li>Demand is generated from assumptions, not observed data. Opening stock was sized for about {num(a.baseCustomersPerDay)} customers a day.</li>
      </ul>
    </>
  );
}

export default function ModelPage() {
  return <Load path="/setup">{(setup) => <Load path="/products">{(p) => <Load path="/declaration">{(d) => <ModelView setup={setup} products={p.products} declaration={d} />}</Load>}</Load>}</Load>;
}
