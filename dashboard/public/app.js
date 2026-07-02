const navLinks = document.querySelectorAll('.nav-link');
const pages = document.querySelectorAll('.page');

function showPage(name) {
  for (const link of navLinks) link.classList.toggle('active', link.dataset.page === name);
  for (const page of pages) page.classList.toggle('active', page.id === `page-${name}`);
  window.scrollTo(0, 0);
}
for (const link of navLinks) {
  link.addEventListener('click', () => showPage(link.dataset.page));
}

// Versions and the raw commit log are read live off disk/git via
// /api/meta on every page load — never hand-edited, so this can't go
// stale the way a hardcoded number in the HTML would the moment
// something ships.
(async () => {
  try {
    const res = await fetch('/api/meta');
    const meta = await res.json();

    const navMeta = document.getElementById('nav-meta');
    if (navMeta) navMeta.innerHTML = `relay v${meta.relayVersion}<br />desktop v${meta.desktopVersion}<br />localhost only`;

    const currentVersion = document.getElementById('patch-current-version');
    if (currentVersion) currentVersion.textContent = `Current — relay v${meta.relayVersion} · desktop v${meta.desktopVersion}`;

    const table = document.getElementById('commit-log-table');
    if (table && meta.commits && meta.commits.length) {
      table.innerHTML = '<tr><th>Commit</th><th>Message</th><th>Date</th></tr>';
      for (const commit of meta.commits) {
        const row = document.createElement('tr');
        const dateStr = new Date(commit.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        const hashCell = document.createElement('td');
        hashCell.innerHTML = `<code>${commit.hash}</code>`;
        const subjectCell = document.createElement('td');
        subjectCell.textContent = commit.subject; // textContent, not innerHTML — never trust commit message content as markup
        const dateCell = document.createElement('td');
        dateCell.className = 'muted';
        dateCell.textContent = dateStr;
        row.append(hashCell, subjectCell, dateCell);
        table.appendChild(row);
      }
    } else if (table) {
      table.innerHTML = '<tr><td colspan="3" class="muted">git log unavailable in this environment.</td></tr>';
    }
  } catch {
    // Non-essential — the curated patch notes above still work fine without it.
  }
})();

const demoBtn = document.getElementById('demo-btn');
const demoOutput = document.getElementById('demo-output');
if (demoBtn) {
  demoBtn.addEventListener('click', async () => {
    demoBtn.disabled = true;
    demoBtn.textContent = 'Running…';
    demoOutput.classList.remove('error');
    demoOutput.classList.add('visible');
    demoOutput.textContent = 'Spinning up a throwaway relay instance and running the real flow…\n';
    try {
      const res = await fetch('/api/run-demo');
      const data = await res.json();
      demoOutput.textContent = data.log || data.error || 'No output.';
      if (!data.ok) demoOutput.classList.add('error');
    } catch (err) {
      demoOutput.classList.add('error');
      demoOutput.textContent = `Failed to reach the dashboard's demo endpoint: ${err.message}`;
    } finally {
      demoBtn.disabled = false;
      demoBtn.textContent = '▶ Run the file-flow demo live';
    }
  });
}
