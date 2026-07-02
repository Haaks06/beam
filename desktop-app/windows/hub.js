const itemsEl = document.getElementById('items');
const statusEl = document.getElementById('status');
const statusTextEl = document.getElementById('status-text');

function timeAgo(ts) {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// Tracks which item ids have already been rendered once, so a full re-render
// (every items-updated push sends the whole recent list) can still tell a
// genuinely new arrival apart from one that was already on screen — only the
// former should play the "just landed" animation. `null` means "nothing
// rendered yet this session," which deliberately skips animating the very
// first paint (opening the Hub shouldn't look like everything just arrived).
let knownItemIds = null;

function renderItems(items) {
  const previousIds = knownItemIds;
  knownItemIds = new Set((items || []).map((item) => item.id));

  if (!items || items.length === 0) {
    itemsEl.innerHTML = '<div class="empty">Nothing beamed yet</div>';
    return;
  }
  itemsEl.innerHTML = '';
  for (const item of items) {
    const isFresh = previousIds !== null && !previousIds.has(item.id);
    const row = document.createElement('div');
    row.className = isFresh ? 'item land-in' : 'item';
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = item.type;
    const content = document.createElement('span');
    content.className = 'content';
    content.textContent = item.type === 'link' ? item.content : (item.fileName || 'photo');
    const action = document.createElement('span');
    action.className = 'action';
    action.textContent = item.type === 'link' ? 'copy' : 'open';
    row.append(kind, content, action);

    row.title = `${item.type === 'link' ? item.content : item.fileName} — ${timeAgo(item.createdAt)}`;

    row.addEventListener('click', async () => {
      if (item.type === 'link') {
        await window.beam.copyText(item.content);
        row.classList.add('copied');
        action.textContent = 'copied';
        setTimeout(() => {
          row.classList.remove('copied');
          action.textContent = 'copy';
        }, 1200);
      } else if (item.filePath) {
        window.beam.openPhoto(item.filePath);
      }
    });

    itemsEl.appendChild(row);
  }
}

function renderStatus(status) {
  statusTextEl.textContent = status;
  statusEl.classList.remove('connected', 'connecting', 'disconnected');
  if (status === 'connected') statusEl.classList.add('connected');
  else if (status === 'disconnected' || status === 'cannot reach relay') statusEl.classList.add('disconnected');
  else statusEl.classList.add('connecting');
}

document.getElementById('pair-btn').addEventListener('click', () => window.beam.pairDevice());
document.getElementById('photos-btn').addEventListener('click', () => window.beam.openFolder('photos'));
document.getElementById('links-btn').addEventListener('click', () => window.beam.openFolder('links'));
document.getElementById('quit-btn').addEventListener('click', () => window.beam.quit());

const pendingBadge = document.getElementById('pending-badge');
document.getElementById('web-panel-btn').addEventListener('click', () => window.beam.openWebPanel());
pendingBadge.addEventListener('click', () => window.beam.openWebPanel());

function renderPendingCount(count) {
  if (count > 0) {
    pendingBadge.textContent = count;
    pendingBadge.style.display = 'inline-block';
  } else {
    pendingBadge.style.display = 'none';
  }
}

window.beam.onItemsUpdated(renderItems);
window.beam.onStatusUpdated(renderStatus);

window.beam.getItems().then(renderItems);
window.beam.getStatus().then(renderStatus);
window.beam.getPendingCount().then(renderPendingCount);
