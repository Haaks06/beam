# Beam dashboard (local only)

A local-only overview of how Beam actually works — flow, security, API reference, and patch notes — plus a button that runs a real end-to-end test against the actual relay-server code and shows exactly where a beamed file goes, step by step.

Not deployed anywhere. Doesn't touch relay-server or web-client's own code or build process.

## Run it

```
node dashboard/server.js
```

Then open **http://localhost:5050** (or set `DASHBOARD_PORT` to use a different port).

## Files

- `server.js` — tiny static server + one API route (`/api/run-demo`) that runs the live demo on request.
- `public/` — the actual page (`index.html`, `style.css`, `app.js`).
- `file-flow-demo.js` — the real demo test. Runnable standalone too: `node dashboard/file-flow-demo.js`.
