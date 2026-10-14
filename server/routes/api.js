// server/routes/api.js - thin HTTP layer: read the request, call a service, return JSON.
// Any :runId can be the literal word "current", which means the Submitted Run.
const express = require('express');
const { HttpError, resolveRun, requireCompleted } = require('../services/util');
const { createAndRunSimulation } = require('../services/runService');
const report = require('../services/reportService');
const days = require('../services/dayService');
const { runAssurance } = require('../services/assuranceService');

const router = express.Router();

// wrap(handler) -> sends whatever the handler returns; thrown errors reach the error handler
const wrap = (fn) => (req, res) => res.json(fn(req));
// withRun(handler) -> resolves :runId and requires it to be completed before reporting on it
const withRun = (fn) => wrap((req) => fn(requireCompleted(resolveRun(req.params.runId)), req));

router.get('/health', wrap(() => ({ status: 'ok' })));

/* ---- runs ---- */
router.get('/runs', wrap(() => ({ runs: report.listRuns() })));
router.get('/runs/:runId', wrap((req) => ({ run: resolveRun(req.params.runId) })));

// Creates a NEW run and simulates it (a few seconds). It never changes the Submitted Run.
// There is deliberately no HTTP route to mark a run as Submitted or to edit any run.
router.post('/runs', (req, res) => {
  const seed = req.body && req.body.seed;
  if (seed != null && !Number.isInteger(seed)) throw new HttpError(400, 'seed must be a whole number');
  res.status(201).json(createAndRunSimulation({ seed: seed ?? undefined }));
});

/* ---- setup and Model Declaration ---- */
router.get('/runs/:runId/setup', withRun((run) => report.getSetup(run)));
router.get('/runs/:runId/products', withRun((run, req) => ({ products: report.getProducts(run, req.query.category) })));
router.get('/runs/:runId/declaration', withRun((run) => report.getDeclaration(run)));

/* ---- 60-Day Commercial Report ---- */
router.get('/runs/:runId/report/performance', withRun((run) => report.getPerformance(run)));   // Part 1
router.get('/runs/:runId/report/operations', withRun((run) => report.getOperations(run)));     // Part 2
router.get('/runs/:runId/report/findings', withRun((run) => report.getFindings(run)));          // Part 3
router.get('/runs/:runId/assurance', withRun((run) => runAssurance(run)));                      // Part 4

/* ---- Daily Reports ---- */
router.get('/runs/:runId/days', withRun((run) => ({ run_id: run.run_id, days: days.listDays(run) })));
router.get('/runs/:runId/days/:day', withRun((run, req) => days.getDay(run, req.params.day)));
router.get('/runs/:runId/days/:day/transactions', withRun((run, req) => days.listTransactions(run, req.params.day, req.query)));

/* ---- traceability: from a reported figure to the stored records ---- */
router.get('/runs/:runId/transactions/:txnId', withRun((run, req) => days.getTransaction(run, req.params.txnId)));
router.get('/runs/:runId/products/:productId/history', withRun((run, req) => days.getProductHistory(run, req.params.productId)));
router.get('/runs/:runId/orders/:orderId', withRun((run, req) => days.getOrder(run, req.params.orderId)));

router.use((req, res) => res.status(404).json({ error: `No such API route: ${req.method} ${req.originalUrl}` }));

module.exports = router;
