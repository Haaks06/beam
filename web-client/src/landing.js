// Beam marketing landing page — minimal, dependency-free interactivity:
// mobile nav toggle, scroll-triggered reveal animations, and a purely
// decorative countdown echoing the product's default 5-minute session
// timer (actually configurable 2-15 minutes in Settings, but the default
// is the honest thing to echo here). Nothing here talks to the relay; the
// actual app lives at /app.

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// -- mobile nav drawer --------------------------------------------------

const navToggle = document.getElementById('nav-toggle');
const navToggleIcon = document.getElementById('nav-toggle-icon');
const navDrawer = document.getElementById('nav-drawer');

function setDrawer(open) {
  navDrawer.classList.toggle('open', open);
  navToggle.setAttribute('aria-expanded', String(open));
  navToggleIcon.querySelector('use').setAttribute('href', open ? '#icon-close' : '#icon-menu');
}

if (navToggle && navDrawer) {
  navToggle.addEventListener('click', () => {
    setDrawer(!navDrawer.classList.contains('open'));
  });

  navDrawer.addEventListener('click', (event) => {
    if (event.target.closest('a')) setDrawer(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && navDrawer.classList.contains('open')) {
      setDrawer(false);
      navToggle.focus();
    }
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 980 && navDrawer.classList.contains('open')) setDrawer(false);
  });
}

// -- scroll-triggered reveal ---------------------------------------------

const revealEls = document.querySelectorAll('.reveal');

if (reduceMotion || !('IntersectionObserver' in window)) {
  revealEls.forEach((el) => el.classList.add('is-visible'));
} else {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.15, rootMargin: '0px 0px -40px 0px' }
  );
  revealEls.forEach((el) => observer.observe(el));
}

// -- decorative countdowns -------------------------------------------------
// Purely cosmetic: loops a "5:00 -> 0:00" clock to echo the real product's
// default session timer, without implying this page itself holds a live
// session.

function formatClock(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function startDecorativeCountdown({ textEl, ringEl, startSeconds = 300 }) {
  if (!textEl && !ringEl) return;
  const total = startSeconds;
  const circumference = ringEl ? 2 * Math.PI * 70 : 0;
  let remaining = startSeconds;

  function tick() {
    if (textEl) textEl.textContent = formatClock(remaining);
    if (ringEl) {
      const fraction = remaining / total;
      ringEl.style.strokeDashoffset = String(circumference * (1 - fraction));
    }
    remaining -= 1;
    if (remaining < 0) remaining = total;
  }

  tick();
  if (!reduceMotion) setInterval(tick, 1000);
}

startDecorativeCountdown({
  textEl: document.getElementById('hero-timer'),
  startSeconds: 298,
});

startDecorativeCountdown({
  textEl: document.getElementById('ring-timer'),
  ringEl: document.querySelector('.timer-ring .progress'),
  startSeconds: 287,
});
