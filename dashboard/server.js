// Standalone local dashboard — deliberately separate from relay-server and
// web-client, touches neither. Serves a static overview page plus one API
// endpoint that runs the real file-flow demo on demand and streams back
// what actually happened, so the "how it works" claims on the page are
// backed by a live execution against the real code, not just prose.
const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const { runFileFlowDemo } = require('./file-flow-demo');

const app = express();
const PORT = process.env.DASHBOARD_PORT || 5050;
const repoRoot = path.join(__dirname, '..');

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

// Read live off disk/git on every request rather than baking version
// numbers and a changelog into the HTML — the whole point of this route
// is that the dashboard can never go stale just because someone forgot
// to hand-edit it after shipping something.
app.get('/api/meta', (req, res) => {
  const readVersion = (pkgPath) => JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
  // relay-server/index.js reports GET /health's version from the ROOT
  // package.json (require('../package.json')), not its own — relay-server's
  // own package.json version has sat unused at 0.1.0 since the start of
  // this project. Reading the root one here is what actually matches what
  // production reports live.
  const relayVersion = readVersion(path.join(repoRoot, 'package.json'));
  const desktopVersion = readVersion(path.join(repoRoot, 'desktop-app', 'package.json'));
  let commits = [];
  try {
    const raw = execSync('git log -20 --format=%h%x1f%s%x1f%ai', { cwd: repoRoot, encoding: 'utf8' });
    commits = raw
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, subject, date] = line.split('\x1f');
        return { hash, subject, date };
      });
  } catch {
    // Not fatal — the page just shows the curated patch notes without
    // the raw-commits supplement if git isn't available in this environment.
  }
  res.json({ relayVersion, desktopVersion, commits });
});

app.listen(PORT, () => {
  console.log(`Beam dashboard: http://localhost:${PORT}`);
});
