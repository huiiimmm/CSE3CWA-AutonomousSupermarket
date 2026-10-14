// server/seed.js  -  loads and validates the product catalogue (safe to re-run)
const fs = require('fs');
const path = require('path');
const db = require('./db');

const BUDGET = 40000;
const products = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'data', 'products.json'), 'utf8')
);

function validate(list) {
  const errors = [];
  const ids = new Set();
  for (const p of list) {
    if (ids.has(p.product_id)) errors.push(`${p.product_id}: duplicate ID`);
    ids.add(p.product_id);
    if (p.unit_price <= p.unit_cost) errors.push(`${p.product_id}: price must exceed cost`);
    if (p.initial_qty < 0) errors.push(`${p.product_id}: negative quantity`);
    if (p.is_perishable && !p.shelf_life_days) errors.push(`${p.product_id}: perishable needs shelf life`);
    if (!p.is_perishable && p.shelf_life_days) errors.push(`${p.product_id}: non-perishable has shelf life`);
  }
  const total = list.reduce((s, p) => s + p.unit_cost * p.initial_qty, 0);
  if (total > BUDGET) errors.push(`opening inventory A$${total.toFixed(2)} exceeds A$${BUDGET}`);
  return { errors, total };
}

const { errors, total } = validate(products);
if (errors.length) {
  console.error('Seed validation failed:\n' + errors.join('\n'));
  process.exit(1);
}

const insert = db.prepare(`
  INSERT OR IGNORE INTO products
  (product_id, name, category, unit_cost, unit_price, initial_qty, is_perishable, shelf_life_days)
  VALUES (@product_id, @name, @category, @unit_cost, @unit_price, @initial_qty, @is_perishable, @shelf_life_days)
`);

db.transaction(() => products.forEach((p) => insert.run({
  product_id: p.product_id, name: p.name, category: p.category,
  unit_cost: p.unit_cost, unit_price: p.unit_price, initial_qty: p.initial_qty,
  is_perishable: p.is_perishable, shelf_life_days: p.shelf_life_days,   // popularity is NOT a table column
})))();

console.log(`Seeded ${products.length} products. Opening inventory cost: A$${total.toFixed(2)} (budget A$${BUDGET}).`);
