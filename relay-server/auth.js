const db = require('./db');

const getDeviceByToken = db.prepare('SELECT * FROM devices WHERE token = ?');
const touchDevice = db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?');

function extractToken(req) {
  const header = req.get('authorization');
  if (header && header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length).trim();
  }
  // EventSource can't send custom headers, so the SSE stream must fall back to a query param.
  if (typeof req.query.token === 'string') {
    return req.query.token;
  }
  return null;
}

function requireToken(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'missing token' });
  }
  const device = getDeviceByToken.get(token);
  if (!device) {
    return res.status(401).json({ error: 'invalid token' });
  }
  touchDevice.run(Date.now(), device.id);
  req.device = device;
  next();
}

module.exports = { requireToken, extractToken };
