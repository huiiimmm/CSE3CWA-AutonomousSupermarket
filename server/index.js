// server/index.js - starts the API
const app = require('./app');
const db = require('./db');

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
  const sub = db.prepare('SELECT run_id FROM runs WHERE is_submitted = 1').get();
  console.log(sub ? `Submitted Run: ${sub.run_id}`
    : 'No Submitted Run yet - create one with: node runSim.js --submit');
});
