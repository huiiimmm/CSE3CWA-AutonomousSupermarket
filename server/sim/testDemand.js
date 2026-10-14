// server/sim/testDemand.js - runs the demand model for 60 days with unlimited stock
const path = require('path');
const config = require('./modelConfig');
const { makeRng } = require('./rng');
const { buildDayContext, generateCustomers } = require('./demand');
const products = require(path.join('..', 'data', 'products.json'));
const byId = Object.fromEntries(products.map((p) => [p.product_id, p]));

const seed = process.argv[2] || config.randomSeed;
const rng = makeRng(seed);

const days = [], hourly = Array(24).fill(0), missions = {}, cat = {}, prod = {};
let lines = 0, units = 0, value = 0, customers = 0;

for (let d = 1; d <= 60; d++) {
  const ctx = buildDayContext(config, d, rng);
  const cs = generateCustomers(config, products, ctx, rng);
  let dayUnits = 0, dayValue = 0;
  for (const c of cs) {
    hourly[Math.floor(c.minute_of_day / 60)]++;
    missions[c.mission] = (missions[c.mission] || 0) + 1;
    for (const w of c.wants) {
      const p = byId[w.product_id];
      lines++; units += w.qty; dayUnits += w.qty;
      const v = w.qty * p.unit_price; value += v; dayValue += v;
      cat[p.category] ||= { units: 0, revenue: 0 };
      cat[p.category].units += w.qty; cat[p.category].revenue += v;
      prod[p.product_id] ||= { name: p.name, units: 0 };
      prod[p.product_id].units += w.qty;
    }
  }
  customers += cs.length;
  days.push({ ...ctx, customers: cs.length, units: dayUnits, revenue: dayValue });
}

const avg = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const wd = days.filter((d) => !d.is_weekend), we = days.filter((d) => d.is_weekend);
console.log('seed', seed);
console.log('customers/day avg', avg(days.map((d) => d.customers)).toFixed(0),
  '| weekday', avg(wd.map((d) => d.customers)).toFixed(0), `(${wd.length}d)`,
  '| weekend', avg(we.map((d) => d.customers)).toFixed(0), `(${we.length}d)`);
console.log('items(lines)/customer', (lines / customers).toFixed(2),
  '| units/customer', (units / customers).toFixed(2),
  '| avg txn value A$', (value / customers).toFixed(2),
  '| units/day', (units / 60).toFixed(0), '| revenue/day A$', (value / 60).toFixed(0));
console.log('hourly share % (0-23):', hourly.map((h) => (100 * h / customers).toFixed(1)).join(' '));
console.log('missions %:', Object.entries(missions).map(([k, v]) => `${k} ${(100 * v / customers).toFixed(0)}`).join(', '));
console.log('category units% / revenue%:');
const tu = units;
for (const [k, v] of Object.entries(cat).sort((a, b) => b[1].revenue - a[1].revenue))
  console.log('  ', k.padEnd(24), (100 * v.units / tu).toFixed(1).padStart(5), (100 * v.revenue / value).toFixed(1).padStart(5));
console.log('top 10 products by units:');
Object.entries(prod).sort((a, b) => b[1].units - a[1].units).slice(0, 10)
  .forEach(([id, v]) => console.log('  ', id, v.name.padEnd(28), v.units));
console.log('bottom 5:');
Object.entries(prod).sort((a, b) => a[1].units - b[1].units).slice(0, 5)
  .forEach(([id, v]) => console.log('  ', id, v.name.padEnd(28), v.units));
console.log('special days:', days.filter((d) => d.special_event).map((d) => `D${d.day} ${d.special_event} (${d.customers})`).join('; ') || 'none');
