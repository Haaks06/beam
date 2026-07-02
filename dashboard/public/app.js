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
