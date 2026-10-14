// server/services/util.js - shared helpers for the read-only report services
const db = require('../db');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const all = (sql, params = {}) => db.prepare(sql).all(params);
const get = (sql, params = {}) => db.prepare(sql).get(params);
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const pct = (a, b) => (b ? r2((100 * a) / b) : 0);

// 'current' means the Submitted Run, so the frontend never needs to know a run ID to start.
function resolveRun(runIdOrCurrent) {
  const run = runIdOrCurrent === 'current'
    ? get('SELECT * FROM runs WHERE is_submitted = 1')
    : get('SELECT * FROM runs WHERE run_id = @id', { id: runIdOrCurrent });
  if (!run) throw new HttpError(404, runIdOrCurrent === 'current'
    ? 'No Submitted Run has been selected yet' : `Run ${runIdOrCurrent} not found`);
  return run;
}

function requireCompleted(run) {
  if (run.status !== 'completed') throw new HttpError(409, `Run ${run.run_id} is ${run.status}, not completed`);
  return run;
}

function parseDay(value) {
  const d = Number(value);
  if (!Number.isInteger(d) || d < 1 || d > 60) throw new HttpError(400, 'day must be a whole number from 1 to 60');
  return d;
}

module.exports = { db, HttpError, all, get, r2, pct, resolveRun, requireCompleted, parseDay };
