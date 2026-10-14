// server/sim/demand.js - generates day context and customers (what people WANT to buy)
// It does not touch stock; the simulation engine decides what can actually be sold.

const WEEKDAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function normalise(arr) {
  const s = arr.reduce((a, b) => a + b, 0);
  return arr.map((x) => x / s);
}

function bandForHour(config, hour) {
  for (const b of config.timeBands) {
    const inBand = b.fromHour <= b.toHour
      ? hour >= b.fromHour && hour <= b.toHour
      : hour >= b.fromHour || hour <= b.toHour;       // wraps midnight
    if (inBand) return b.name;
  }
  throw new Error('No time band for hour ' + hour);
}

// Decide how busy a day is and why.
function buildDayContext(config, day, rng) {
  const a = config.arrivals;
  const weekdayIndex = (a.startWeekday + day - 1) % 7;
  const isWeekend = weekdayIndex === 0 || weekdayIndex === 6;
  const dayTypeMult = isWeekend ? a.weekendMultiplier : a.weekdayMultiplier;

  const noise = Math.min(a.noiseClip[1], Math.max(a.noiseClip[0], rng.normal(1, a.dailyNoiseSd)));

  let eventName = null, eventMult = 1;
  for (const ev of a.specialEvents) {
    if (rng.next() < ev.probPerDay) { eventName = ev.name; eventMult = ev.multiplier; break; }
  }

  return {
    day,
    weekday_name: WEEKDAY_NAMES[weekdayIndex],
    is_weekend: isWeekend ? 1 : 0,
    day_type_multiplier: dayTypeMult,
    noise_multiplier: Number(noise.toFixed(4)),
    special_event: eventName,
    event_multiplier: eventMult,
    expected_customers: Number((a.baseCustomersPerDay * dayTypeMult * noise * eventMult).toFixed(1)),
  };
}

function missionWeights(config, band, isWeekend) {
  const base = config.missionMixByBand[band];
  return config.missionOrder.map((m, i) =>
    base[i] * (isWeekend ? config.weekendMissionBoost[m] : 1));
}

// Build the product lookup once per run: category -> { products, popularity weights }
function indexProducts(products) {
  const byCategory = {};
  for (const p of products) {
    (byCategory[p.category] ||= { items: [], weights: [] });
    byCategory[p.category].items.push(p);
    byCategory[p.category].weights.push(p.popularity);
  }
  return byCategory;
}

function buildBasket(config, index, mission, rng) {
  const m = config.missions[mission];
  const target = rng.fromTable(m.distinctItems);
  const cats = Object.keys(m.categoryWeights);
  const catW = cats.map((c) => m.categoryWeights[c]);
  const chosen = new Map();                         // product_id -> line
  let attempts = 0;
  while (chosen.size < target && attempts++ < target * 6) {
    const cat = rng.weighted(cats, catW);
    const group = index[cat];
    if (!group) continue;
    const product = rng.weighted(group.items, group.weights);
    if (chosen.has(product.product_id)) continue;   // no duplicate lines
    const qty = rng.fromTable(config.quantityByCategory[cat]);
    chosen.set(product.product_id, { product_id: product.product_id, category: cat, qty });
  }
  return [...chosen.values()];
}

// Generate every customer for one day, sorted by arrival time.
function generateCustomers(config, products, ctx, rng) {
  const index = indexProducts(products);
  const shares = normalise(config.arrivals.hourlyShare[ctx.is_weekend ? 'weekend' : 'weekday']);
  const customers = [];
  for (let hour = 0; hour < 24; hour++) {
    const count = rng.poisson(ctx.expected_customers * shares[hour]);
    const band = bandForHour(config, hour);
    const weights = missionWeights(config, band, ctx.is_weekend);
    for (let i = 0; i < count; i++) {
      const mission = rng.weighted(config.missionOrder, weights);
      customers.push({
        minute_of_day: hour * 60 + rng.int(0, 59),
        mission,
        wants: buildBasket(config, index, mission, rng),
      });
    }
  }
  customers.sort((x, y) => x.minute_of_day - y.minute_of_day);
  return customers;
}

module.exports = { buildDayContext, generateCustomers, bandForHour };

