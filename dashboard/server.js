// Standalone local dashboard — deliberately separate from relay-server and
// web-client, touches neither. Serves a static overview page plus one API
// endpoint that runs the real file-flow demo on demand and streams back
// what actually happened, so the "how it works" claims on the page are
// backed by a live execution against the real code, not just prose.
const express = require('express');
const path = require('node:path');
const { runFileFlowDemo } = require('./file-flow-demo');

const app = express();
const PORT = process.env.DASHBOARD_PORT || 5050;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/run-demo', async (req, res) => {
  const lines = [];
  try {
    const result = await runFileFlowDemo({ log: (line) => lines.push(line) });
    res.json({ ok: true, log: lines.join('\n'), steps: result.steps });
  } catch (err) {
    res.status(500).json({ ok: false, log: lines.join('\n'), error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Beam dashboard: http://localhost:${PORT}`);
});
