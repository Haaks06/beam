const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function save(config) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function update(patch) {
  const next = { ...load(), ...patch };
  save(next);
  return next;
}

module.exports = { load, save, update, CONFIG_PATH };
