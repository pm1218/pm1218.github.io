// Shared app state and navigation helpers used by every screen.
import { CONFIG } from './config.js';
import { h, clear } from './ui.js';

export const view = document.getElementById('view');
export const nav = document.getElementById('tabbar');
export const state = { me: null, profiles: [] };

// Navigate; re-render when already on that route (app.js listens for hashchange).
export const go = (hash) => {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
};
export const profileName = (id) => state.profiles.find((p) => p.id === id)?.display_name ?? 'Unknown';
export const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
};

export function setTitle(t) { document.title = t ? `${t} · ${CONFIG.APP_NAME}` : CONFIG.APP_NAME; }

export function page(title, ...children) {
  setTitle(title);
  clear(view).append(h('h1', { class: 'page-title', tabindex: '-1' }, title), ...children.filter(Boolean));
  view.querySelector('.page-title').focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

export function renderNav(active) {
  const items = [['#/events', 'Events', '🏁'], ['#/stats', 'Stats', '📊'], ['#/me', 'Me', '🙂']];
  if (state.me?.isAdmin) items.push(['#/admin', 'Admin', '🔑']);
  clear(nav).append(...items.map(([href, label, icon]) =>
    h('a', { href, class: active === href ? 'active' : '', 'aria-current': active === href ? 'page' : null },
      h('span', { class: 'tab-icon', 'aria-hidden': 'true' }, icon), h('span', {}, label))));
  nav.hidden = !state.me;
}
