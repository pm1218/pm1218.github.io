// Single-page app: hash router + start-up. Each screen lives in js/views/.
// No build step — GitHub Pages serves these files as-is. Hash routes
// (#/events/…) work on static hosting and keep the back button working.

import * as api from './api.js';
import { h, clear, spinner, toast } from './ui.js';
import { view, state, go, page, renderNav } from './core.js';
import { viewSetup, viewLogin } from './views/auth.js';
import { viewEvents, viewEvent } from './views/events.js';
import { viewGp } from './views/session.js';
import { viewStats } from './views/stats.js';
import { viewMe, viewAdmin } from './views/account.js';

// =================================================================== router
const routes = [
  [/^#\/events\/([\w-]+)$/, viewEvent],
  [/^#\/events\/?$/, viewEvents],
  [/^#\/gp\/([\w-]+)$/, viewGp],
  [/^#\/stats\/([\w-]+)$/, viewStats],
  [/^#\/stats\/?$/, () => viewStats(null)],
  [/^#\/me$/, viewMe],
  [/^#\/admin$/, viewAdmin],
];

async function route() {
  if (!api.configured) return viewSetup();
  if (!state.me) return viewLogin(boot);
  const hash = location.hash || '#/events';
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (m) {
      renderNav(`#/${hash.split('/')[1]}`);
      try {
        await fn(...m.slice(1));
      } catch (e) {
        console.error(e);
        page('Something went wrong', h('div', { class: 'card' }, h('p', {}, e.message), h('a', { class: 'btn', href: '#/events' }, 'Back to events')));
      }
      return;
    }
  }
  go('#/events');
}

async function boot() {
  if (!api.configured) return viewSetup();
  clear(view).append(spinner('Starting…'));
  const session = await api.getSession();
  if (!session) { state.me = null; return route(); }
  // Profiles load alongside the membership check: one round trip, not two.
  const profilesP = api.listProfiles().catch(() => []);
  const me = await api.loadMe(session);
  if (!me.approved) {
    await api.signOut();
    state.me = null;
    toast('That email is not on the member list. Ask an admin to add you.', 'error');
    return route();
  }
  state.me = me;
  state.profiles = await profilesP;
  // Close out events idle for 12 h. The database does this every 10 minutes
  // too, and screens work out live/over themselves, so don't wait for it.
  api.finalizeStale().catch((e) => console.warn('auto-finalize', e));
  if (location.hash.startsWith('#/login') || !location.hash) location.replace('#/events');
  route();
}

window.addEventListener('hashchange', route);
if (api.sb) {
  api.sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') { api.invalidate(); state.me = null; route(); }
  });
}
boot();
