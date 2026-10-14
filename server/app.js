// server/app.js - builds the Express app (index.js starts it)
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('./db');                                   // opens SQLite and ensures the schema exists
const apiRouter = require('./routes/api');

const app = express();
app.use(cors());
app.use(express.json());
app.use('/api', apiRouter);

// If the React app has been built, serve it too (one command runs everything).
const dist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(path.join(dist, 'index.html'))) {
  app.use(express.static(dist));
  app.use((req, res, next) =>
    req.method === 'GET' && !req.path.startsWith('/api') ? res.sendFile(path.join(dist, 'index.html')) : next());
}

function errorHandler(err, req, res, next) {          // eslint-disable-line no-unused-vars
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
}
app.use(errorHandler);

module.exports = app;
module.exports.errorHandler = errorHandler;
