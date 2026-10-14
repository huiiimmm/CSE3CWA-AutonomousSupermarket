// server/sim/modelConfig.js
// Every assumption of the customer/demand model lives here.
// This object is copied into run_config when a run is created and then frozen.

module.exports = {
  modelVersion: 'demand-v1',

  // ---------- 1. Customer arrivals ----------
  arrivals: {
    baseCustomersPerDay: 800,        // average day before any multipliers
    startWeekday: 1,                 // Day 1 is a Monday (0=Sun ... 6=Sat)
    weekdayMultiplier: 1.10,         // office workers around Town Hall
    weekendMultiplier: 0.70,
    dailyNoiseSd: 0.08,              // random day-to-day variation (8%)
    noiseClip: [0.75, 1.25],         // stops extreme noise
    // At most one special event per day; checked in order.
    specialEvents: [
      { name: 'Major city event nearby', probPerDay: 0.04, multiplier: 1.35 },
      { name: 'Heavy rain',              probPerDay: 0.05, multiplier: 0.85 },
    ],
    // Share of each day's customers arriving in each hour (0-23). Normalised in code.
    hourlyShare: {
      weekday: [0.008,0.005,0.002,0.002,0.004,0.010,0.030,0.075,0.095,0.060,0.045,0.065,
                0.110,0.095,0.050,0.040,0.055,0.090,0.070,0.040,0.025,0.015,0.010,0.007],
      weekend: [0.010,0.008,0.004,0.002,0.002,0.005,0.015,0.030,0.055,0.075,0.090,0.095,
                0.100,0.095,0.085,0.075,0.065,0.055,0.045,0.035,0.025,0.018,0.012,0.012],
    },
  },

  // ---------- 2. Shopping missions ----------
  // Mission mix depends on the time band of arrival.
  timeBands: [
    { name: 'morning',   fromHour: 5,  toHour: 10 },
    { name: 'midday',    fromHour: 11, toHour: 14 },
    { name: 'afternoon', fromHour: 15, toHour: 17 },
    { name: 'evening',   fromHour: 18, toHour: 20 },
    { name: 'night',     fromHour: 21, toHour: 4 },   // wraps past midnight
  ],
  missionOrder: ['meal_on_the_go', 'quick_drink_snack', 'topup_grocery', 'household_personal', 'evening_meal'],
  missionMixByBand: {
    morning:   [0.45, 0.30, 0.15, 0.10, 0.00],
    midday:    [0.55, 0.20, 0.12, 0.08, 0.05],
    afternoon: [0.20, 0.40, 0.20, 0.10, 0.10],
    evening:   [0.10, 0.15, 0.30, 0.10, 0.35],
    night:     [0.20, 0.50, 0.10, 0.10, 0.10],
  },
  // Weekend shoppers do more top-up/household shopping and less office-lunch buying.
  weekendMissionBoost: {
    meal_on_the_go: 0.6, quick_drink_snack: 1.0, topup_grocery: 1.6,
    household_personal: 1.6, evening_meal: 1.0,
  },

  // ---------- 3. Basket structure per mission ----------
  missions: {
    meal_on_the_go: {
      distinctItems: { 1: 0.20, 2: 0.45, 3: 0.35 },
      categoryWeights: { 'Ready-to-Eat': 0.45, 'Drinks': 0.25, 'Dairy & Chilled': 0.12,
                         'Snacks & Confectionery': 0.10, 'Fresh & Bakery': 0.08 },
    },
    quick_drink_snack: {
      distinctItems: { 1: 0.55, 2: 0.35, 3: 0.10 },
      categoryWeights: { 'Drinks': 0.45, 'Snacks & Confectionery': 0.30, 'Dairy & Chilled': 0.10,
                         'Ready-to-Eat': 0.10, 'Fresh & Bakery': 0.05 },
    },
    topup_grocery: {
      distinctItems: { 3: 0.20, 4: 0.30, 5: 0.30, 6: 0.20 },
      categoryWeights: { 'Grocery & Pantry': 0.35, 'Dairy & Chilled': 0.20, 'Fresh & Bakery': 0.18,
                         'Drinks': 0.10, 'Snacks & Confectionery': 0.07, 'Ready-to-Eat': 0.05,
                         'Personal & Convenience': 0.05 },
    },
    household_personal: {
      distinctItems: { 2: 0.40, 3: 0.40, 4: 0.20 },
      categoryWeights: { 'Household': 0.45, 'Personal & Convenience': 0.40,
                         'Grocery & Pantry': 0.10, 'Drinks': 0.05 },
    },
    evening_meal: {
      distinctItems: { 3: 0.30, 4: 0.40, 5: 0.30 },
      categoryWeights: { 'Fresh & Bakery': 0.25, 'Grocery & Pantry': 0.25, 'Ready-to-Eat': 0.20,
                         'Dairy & Chilled': 0.20, 'Drinks': 0.10 },
    },
  },

  // ---------- 4. Quantity per product line ----------
  // probability of buying 1, 2, 3 units of the same product
  quantityByCategory: {
    'Drinks':                 { 1: 0.70, 2: 0.22, 3: 0.08 },
    'Snacks & Confectionery': { 1: 0.78, 2: 0.17, 3: 0.05 },
    'Grocery & Pantry':       { 1: 0.75, 2: 0.18, 3: 0.07 },
    'Ready-to-Eat':           { 1: 0.92, 2: 0.07, 3: 0.01 },
    'Dairy & Chilled':        { 1: 0.88, 2: 0.10, 3: 0.02 },
    'Fresh & Bakery':         { 1: 0.88, 2: 0.10, 3: 0.02 },
    'Household':              { 1: 0.90, 2: 0.08, 3: 0.02 },
    'Personal & Convenience': { 1: 0.90, 2: 0.08, 3: 0.02 },
  },

  // ---------- 5. When stock is missing (applied by the simulation engine) ----------
  stockoutBehaviour: {
    substituteProbability: 0.50,     // else the customer skips the item
    // substitute is another in-stock product from the same category, popularity-weighted
  },

  // ---------- 6. Store Brain rules (frozen with the run) ----------
  storeBrain: {
    lookbackDays: 14,                // sales history window used for demand rates
    minSameTypeDays: 2,              // need this many weekday (or weekend) days to use a day-type forecast
    useUnmetDemandSignal: true,      // count out-of-stock attempts as demand (see Model Declaration)
    safetyFactor: 1.15,              // long-life products: buffer on forecast demand
    maxSafetyZ: 1.0,                 // short-life products: cap on the safety-stock z-score
    fallbackCV: 0.25,                // assumed demand variability when history is short
    minObsForSigma: 4,               // days of same-type history needed to measure variability

    // Low stock: closing stock measured in days of normal sales
    lowStockCoverDays: 1.5,          // long-life products (below the reorder point on purpose)
    lowStockCoverDaysShort: 0,       // short-life perishables are run near zero by design: only sold-out is alerted
    shortLifeMaxDays: 14,

    // Replenishment
    reorderPointCoverDays: 3,        // long-life: reorder when cover falls to this
    orderUpToCoverDays: 8,           // long-life: order back up to this many days of cover
    orderUpToShelfFraction: 0.5,     // ...but never more than this fraction of shelf life
    perishableShelfFraction: 0.5,    // short-life: cover days = shelf life x this ...
    perishableMinCoverDays: 1,
    perishableMaxCoverDays: 3,       // ... clamped between min and max
    cashReserve: 0,                  // cash the Brain refuses to spend

    // Expiry
    expiryWarningDays: 2,            // warn when a batch has <= this many selling days left
    minAtRiskUnits: 3,               // ...and at least this many units look unlikely to sell

    // Slow movers
    slowMinDay: 8,                   // need a week of history first
    slowCoverDays: 10,               // cover above this = slow-moving (long-life products only)
  },

  randomSeed: 20260001,
};
