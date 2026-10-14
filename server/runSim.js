// server/runSim.js - create and run one simulation from the command line
//   node runSim.js                 new run with a random seed
//   node runSim.js --seed 20260001 new run with a chosen seed
//   node runSim.js --submit        also mark it as the Submitted Run
const { createAndRunSimulation, markSubmitted } = require('./services/runService');

const args = process.argv.slice(2);
const seedAt = args.indexOf('--seed');
const seed = seedAt >= 0 ? Number(args[seedAt + 1]) : undefined;

try {
  const r = createAndRunSimulation({ seed });
  console.log(`Run ${r.run_id} ${r.status} in ${r.seconds.toFixed(1)}s (seed ${r.seed})`);
  console.log(`customers ${r.customers} | transactions ${r.txns} | units ${r.units}`);
  console.log(`revenue A$${r.revenue.toFixed(2)} | COGS A$${r.cogs.toFixed(2)} | gross profit A$${r.gross_profit.toFixed(2)}`);
  console.log(`write-offs A$${r.writeoff.toFixed(2)} | replenishment A$${r.spend.toFixed(2)}`);
  console.log(`closing cash A$${r.closingCash.toFixed(2)} | closing inventory A$${r.closingInventory.toFixed(2)}`);
  if (args.includes('--submit')) { markSubmitted(r.run_id); console.log('Marked as the Submitted Run.'); }
} catch (err) {
  console.error('Simulation failed:', err.message, err.runId ? `(run ${err.runId} marked failed)` : '');
  process.exit(1);
}
