// server/db.js
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'supermarket.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  /* ---------- A. CONFIGURATION ---------- */

  CREATE TABLE IF NOT EXISTS products (
    product_id      TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    category        TEXT NOT NULL,
    unit_cost       REAL NOT NULL CHECK (unit_cost > 0),
    unit_price      REAL NOT NULL CHECK (unit_price > 0),
    initial_qty     INTEGER NOT NULL CHECK (initial_qty >= 0),
    is_perishable   INTEGER NOT NULL CHECK (is_perishable IN (0,1)),
    shelf_life_days INTEGER CHECK (shelf_life_days IS NULL OR shelf_life_days > 0),
    CHECK (is_perishable = 0 OR shelf_life_days IS NOT NULL)
  );

  CREATE TABLE IF NOT EXISTS runs (
    run_id           TEXT PRIMARY KEY,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at     TEXT,
    status           TEXT NOT NULL DEFAULT 'created'
                     CHECK (status IN ('created','running','completed','failed')),
    inventory_budget REAL NOT NULL DEFAULT 40000,
    opening_cash     REAL NOT NULL DEFAULT 15000,
    random_seed      INTEGER,
    is_submitted     INTEGER NOT NULL DEFAULT 0 CHECK (is_submitted IN (0,1))
  );

  CREATE TABLE IF NOT EXISTS run_config (
    run_id      TEXT PRIMARY KEY REFERENCES runs(run_id),
    config_json TEXT NOT NULL   -- customer model + Store Brain rules, frozen
  );

  CREATE TABLE IF NOT EXISTS run_products (
    run_id          TEXT NOT NULL REFERENCES runs(run_id),
    product_id      TEXT NOT NULL,
    name            TEXT NOT NULL,
    category        TEXT NOT NULL,
    unit_cost       REAL NOT NULL CHECK (unit_cost > 0),
    unit_price      REAL NOT NULL CHECK (unit_price > 0),
    opening_qty     INTEGER NOT NULL CHECK (opening_qty >= 0),
    is_perishable   INTEGER NOT NULL CHECK (is_perishable IN (0,1)),
    shelf_life_days INTEGER,
    PRIMARY KEY (run_id, product_id)
  );

  /* ---------- B. HISTORY (append-only) ---------- */

  CREATE TABLE IF NOT EXISTS customers (
    customer_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id        TEXT NOT NULL REFERENCES runs(run_id),
    day           INTEGER NOT NULL CHECK (day BETWEEN 1 AND 60),
    minute_of_day INTEGER NOT NULL CHECK (minute_of_day BETWEEN 0 AND 1439),
    mission       TEXT NOT NULL,
    purchased     INTEGER NOT NULL DEFAULT 0 CHECK (purchased IN (0,1))
  );

  CREATE TABLE IF NOT EXISTS transactions (
    txn_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id        TEXT NOT NULL REFERENCES runs(run_id),
    day           INTEGER NOT NULL CHECK (day BETWEEN 1 AND 60),
    customer_id   INTEGER NOT NULL REFERENCES customers(customer_id),
    minute_of_day INTEGER NOT NULL,
    total_amount  REAL NOT NULL CHECK (total_amount >= 0)
  );

  CREATE TABLE IF NOT EXISTS inventory_batches (
    batch_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id       TEXT NOT NULL REFERENCES runs(run_id),
    product_id   TEXT NOT NULL,
    source       TEXT NOT NULL CHECK (source IN ('opening','replenishment')),
    received_day INTEGER NOT NULL CHECK (received_day BETWEEN 1 AND 60),
    expiry_day   INTEGER,        -- NULL for non-perishables
    qty_received INTEGER NOT NULL CHECK (qty_received > 0),
    unit_cost    REAL NOT NULL CHECK (unit_cost > 0),
    order_id     INTEGER,
    FOREIGN KEY (run_id, product_id) REFERENCES run_products(run_id, product_id)
  );

  CREATE TABLE IF NOT EXISTS transaction_items (
    item_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    txn_id     INTEGER NOT NULL REFERENCES transactions(txn_id),
    run_id     TEXT NOT NULL REFERENCES runs(run_id),
    day        INTEGER NOT NULL,
    product_id TEXT NOT NULL,
    batch_id   INTEGER NOT NULL REFERENCES inventory_batches(batch_id),
    quantity   INTEGER NOT NULL CHECK (quantity > 0),
    unit_price REAL NOT NULL CHECK (unit_price > 0),
    unit_cost  REAL NOT NULL CHECK (unit_cost > 0),
    line_total REAL NOT NULL CHECK (line_total >= 0),
    FOREIGN KEY (run_id, product_id) REFERENCES run_products(run_id, product_id)
  );

  CREATE TABLE IF NOT EXISTS inventory_movements (
    movement_id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      TEXT NOT NULL REFERENCES runs(run_id),
    day         INTEGER NOT NULL CHECK (day BETWEEN 1 AND 60),
    product_id  TEXT NOT NULL,
    batch_id    INTEGER NOT NULL REFERENCES inventory_batches(batch_id),
    type        TEXT NOT NULL CHECK (type IN ('opening','received','sold','expired')),
    qty_change  INTEGER NOT NULL CHECK (qty_change <> 0),
    txn_id      INTEGER REFERENCES transactions(txn_id),
    FOREIGN KEY (run_id, product_id) REFERENCES run_products(run_id, product_id)
  );

  CREATE TABLE IF NOT EXISTS replenishment_orders (
    order_id         INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id           TEXT NOT NULL REFERENCES runs(run_id),
    product_id       TEXT NOT NULL,
    placed_day       INTEGER NOT NULL CHECK (placed_day BETWEEN 1 AND 59),
    arrival_day      INTEGER NOT NULL CHECK (arrival_day BETWEEN 2 AND 60),
    qty_wanted       INTEGER NOT NULL CHECK (qty_wanted > 0),
    qty_ordered      INTEGER NOT NULL CHECK (qty_ordered >= 0),
    unit_cost        REAL NOT NULL,
    total_cost       REAL NOT NULL CHECK (total_cost >= 0),
    cash_before      REAL NOT NULL,
    cash_constrained INTEGER NOT NULL DEFAULT 0 CHECK (cash_constrained IN (0,1)),
    reason           TEXT NOT NULL,
    CHECK (arrival_day = placed_day + 1),
    CHECK (total_cost <= cash_before),
    FOREIGN KEY (run_id, product_id) REFERENCES run_products(run_id, product_id)
  );

  CREATE TABLE IF NOT EXISTS expiry_events (
    expiry_id  INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id     TEXT NOT NULL REFERENCES runs(run_id),
    day        INTEGER NOT NULL CHECK (day BETWEEN 1 AND 60),
    product_id TEXT NOT NULL,
    batch_id   INTEGER NOT NULL REFERENCES inventory_batches(batch_id),
    quantity   INTEGER NOT NULL CHECK (quantity > 0),
    value      REAL NOT NULL CHECK (value >= 0),   -- at cost
    FOREIGN KEY (run_id, product_id) REFERENCES run_products(run_id, product_id)
  );

  CREATE TABLE IF NOT EXISTS cash_ledger (
    entry_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id        TEXT NOT NULL REFERENCES runs(run_id),
    day           INTEGER NOT NULL CHECK (day BETWEEN 1 AND 60),
    type          TEXT NOT NULL CHECK (type IN ('opening','sales','replenishment')),
    amount        REAL NOT NULL,          -- + in, - out
    balance_after REAL NOT NULL CHECK (balance_after >= 0),
    order_id      INTEGER REFERENCES replenishment_orders(order_id)
  );

  CREATE TABLE IF NOT EXISTS store_brain_events (
    event_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id     TEXT NOT NULL REFERENCES runs(run_id),
    day        INTEGER NOT NULL CHECK (day BETWEEN 1 AND 60),
    product_id TEXT,
    condition  TEXT NOT NULL CHECK (condition IN
               ('low_stock','sold_out','expiry_warning','expired_removed',
                'slow_mover','replenishment','cash_constrained')),
    action     TEXT NOT NULL,
    detail     TEXT NOT NULL,             -- rule triggered + numbers used
    outcome    TEXT,
    order_id   INTEGER REFERENCES replenishment_orders(order_id)
  );

  /* ---------- C. DERIVED ---------- */

  CREATE TABLE IF NOT EXISTS daily_summaries (
    run_id                  TEXT NOT NULL REFERENCES runs(run_id),
    day                     INTEGER NOT NULL CHECK (day BETWEEN 1 AND 60),
    customers               INTEGER NOT NULL,
    transactions            INTEGER NOT NULL,
    units_sold              INTEGER NOT NULL,
    revenue                 REAL NOT NULL,
    cogs                    REAL NOT NULL,
    gross_profit            REAL NOT NULL,
    writeoff_value          REAL NOT NULL,
    replenishment_spend     REAL NOT NULL,
    closing_cash            REAL NOT NULL,
    closing_inventory_value REAL NOT NULL,
    PRIMARY KEY (run_id, day)
  );

  /* ---------- D. LOST SALES ---------- */


  CREATE TABLE IF NOT EXISTS day_context (
    run_id              TEXT NOT NULL REFERENCES runs(run_id),
    day                 INTEGER NOT NULL CHECK (day BETWEEN 1 AND 60),
    weekday_name        TEXT NOT NULL,
    is_weekend          INTEGER NOT NULL CHECK (is_weekend IN (0,1)),
    day_type_multiplier REAL NOT NULL,
    noise_multiplier    REAL NOT NULL,
    special_event       TEXT,
    event_multiplier    REAL NOT NULL,
    expected_customers  REAL NOT NULL,
    PRIMARY KEY (run_id, day)
  );

  CREATE TABLE IF NOT EXISTS missed_demand (
    missed_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id       TEXT NOT NULL REFERENCES runs(run_id),
    day          INTEGER NOT NULL CHECK (day BETWEEN 1 AND 60),
    customer_id  INTEGER NOT NULL REFERENCES customers(customer_id),
    product_id   TEXT NOT NULL,
    units_missed INTEGER NOT NULL CHECK (units_missed > 0),
    lost_revenue REAL NOT NULL CHECK (lost_revenue >= 0),
    reason       TEXT NOT NULL CHECK (reason IN ('sold_out','partial_stock')),
    outcome      TEXT NOT NULL CHECK (outcome IN ('substituted','lost')),
    FOREIGN KEY (run_id, product_id) REFERENCES run_products(run_id, product_id)
  );

  /* ---------- INDEXES ---------- */

  CREATE INDEX IF NOT EXISTS idx_customers_run_day  ON customers(run_id, day);
  CREATE INDEX IF NOT EXISTS idx_txn_run_day        ON transactions(run_id, day);
  CREATE INDEX IF NOT EXISTS idx_items_txn          ON transaction_items(txn_id);
  CREATE INDEX IF NOT EXISTS idx_items_run_product  ON transaction_items(run_id, product_id);
  CREATE INDEX IF NOT EXISTS idx_batches_run_prod   ON inventory_batches(run_id, product_id);
  CREATE INDEX IF NOT EXISTS idx_moves_run_day      ON inventory_movements(run_id, day);
  CREATE INDEX IF NOT EXISTS idx_moves_run_product  ON inventory_movements(run_id, product_id);
  CREATE INDEX IF NOT EXISTS idx_orders_run_day     ON replenishment_orders(run_id, placed_day);
  CREATE INDEX IF NOT EXISTS idx_expiry_run_day     ON expiry_events(run_id, day);
  CREATE INDEX IF NOT EXISTS idx_cash_run_day       ON cash_ledger(run_id, day);
  CREATE INDEX IF NOT EXISTS idx_brain_run_day      ON store_brain_events(run_id, day);
  CREATE INDEX IF NOT EXISTS idx_missed_run_day  ON missed_demand(run_id, day);
  CREATE INDEX IF NOT EXISTS idx_missed_run_prod ON missed_demand(run_id, product_id);
`);

/* ---------- APPEND-ONLY PROTECTION (triggers) ---------- */

const historyTables = [
  'customers', 'transactions', 'transaction_items', 'inventory_batches',
  'inventory_movements', 'replenishment_orders', 'expiry_events',
  'cash_ledger', 'store_brain_events', 'daily_summaries',
];

for (const t of historyTables) {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${t}_no_update BEFORE UPDATE ON ${t}
    BEGIN SELECT RAISE(ABORT, '${t} is append-only: updates not allowed'); END;

    CREATE TRIGGER IF NOT EXISTS ${t}_no_delete BEFORE DELETE ON ${t}
    BEGIN SELECT RAISE(ABORT, '${t} is append-only: deletes not allowed'); END;

    CREATE TRIGGER IF NOT EXISTS ${t}_only_while_running BEFORE INSERT ON ${t}
    WHEN (SELECT status FROM runs WHERE run_id = NEW.run_id) <> 'running'
    BEGIN SELECT RAISE(ABORT, 'history can only be written while a run is running'); END;
  `);
}

// Frozen configuration: insert only while run is 'created', never edit.
for (const t of ['run_config', 'run_products']) {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${t}_no_update BEFORE UPDATE ON ${t}
    BEGIN SELECT RAISE(ABORT, 'run configuration is frozen'); END;

    CREATE TRIGGER IF NOT EXISTS ${t}_no_delete BEFORE DELETE ON ${t}
    BEGIN SELECT RAISE(ABORT, 'run configuration is frozen'); END;

    CREATE TRIGGER IF NOT EXISTS ${t}_only_when_created BEFORE INSERT ON ${t}
    WHEN (SELECT status FROM runs WHERE run_id = NEW.run_id) <> 'created'
    BEGIN SELECT RAISE(ABORT, 'configuration can only be set before a run starts'); END;
  `);
}

// Runs: never deleted, core settings locked after creation, status can't go backwards.
db.exec(`
  CREATE TRIGGER IF NOT EXISTS runs_no_delete BEFORE DELETE ON runs
  BEGIN SELECT RAISE(ABORT, 'runs cannot be deleted'); END;

  CREATE TRIGGER IF NOT EXISTS runs_lock_settings
  BEFORE UPDATE OF run_id, inventory_budget, opening_cash, random_seed, created_at ON runs
  BEGIN SELECT RAISE(ABORT, 'run settings are frozen'); END;

  CREATE TRIGGER IF NOT EXISTS runs_status_forward_only
  BEFORE UPDATE OF status ON runs
  WHEN OLD.status IN ('completed','failed') AND NEW.status <> OLD.status
  BEGIN SELECT RAISE(ABORT, 'finished runs cannot change status'); END;

  CREATE TRIGGER IF NOT EXISTS runs_submit_only_completed
  BEFORE UPDATE OF is_submitted ON runs
  WHEN NEW.is_submitted = 1 AND NEW.status <> 'completed'
  BEGIN SELECT RAISE(ABORT, 'only a completed run can be the Submitted Run'); END;
`);

module.exports = db;
