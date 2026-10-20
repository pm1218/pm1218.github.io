// Single-page app: hash router + views. No build step — GitHub Pages serves
// these files as-is. Hash routes (#/events/…) work on static hosting and
// keep the browser/phone back button behaving normally.

import { CONFIG } from './config.js';
import * as api from './api.js';
import {
  CHARACTERS, ALL_TRACKS, ENGINE_CLASSES, EVENT_KINDS, MAX_PLAYERS,
  MAX_GP_TOTAL, RACES_PER_GP, ordinal, pointsFor,
} from './data.js';
import {
  emptyDraft, makeParticipant, validateDraft, computeStandings, toPayload,
  completedRaceCount, isRaceComplete, draftFromScreens, addExtraAsPlayer,
} from './scoring.js';
import { suggestIdentities } from './identity.js';
import {
  powerRankings, eloRatings, consistencyMetrics, trackStats, headToHead, headToHeadMatrix, insights,
} from './analytics.js';
import { h, clear, selectEl, toast, charBadge, fmtDate, fmtDateTime, spinner, emptyState, busy, table } from './ui.js';

const view = document.getElementById('view');
const nav = document.getElementById('tabbar');
const state = { me: null, profiles: [] };

const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };
const profileName = (id) => state.profiles.find((p) => p.id === id)?.display_name ?? 'Unknown';
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
};

function setTitle(t) { document.title = t ? `${t} · ${CONFIG.APP_NAME}` : CONFIG.APP_NAME; }

function page(title, ...children) {
  setTitle(title);
  clear(view).append(h('h1', { class: 'page-title', tabindex: '-1' }, title), ...children.filter(Boolean));
  view.querySelector('.page-title').focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

function renderNav(active) {
  const items = [['#/events', 'Events', '🏁'], ['#/stats', 'Stats', '📊'], ['#/me', 'Me', '🙂']];
  if (state.me?.isAdmin) items.push(['#/admin', 'Admin', '🔑']);
  clear(nav).append(...items.map(([href, label, icon]) =>
    h('a', { href, class: active === href ? 'active' : '', 'aria-current': active === href ? 'page' : null },
      h('span', { class: 'tab-icon', 'aria-hidden': 'true' }, icon), h('span', {}, label))));
  nav.hidden = !state.me;
}

// ===================================================================== auth
function viewSetup() {
  nav.hidden = true;
  page('Almost there',
    h('div', { class: 'card' },
      h('p', {}, 'This app needs its free Supabase backend connected. Add your project URL and anon key to ', h('code', {}, 'mariokart/js/config.js'), ', commit, and reload.'),
      h('p', { class: 'muted' }, 'Full steps are in mariokart/README.md → Deployment.')));
}

function viewLogin() {
  nav.hidden = true;
  setTitle('Sign in');
  let email = store.get('mk-login-email') || '';
  let codeSent = Boolean(store.get('mk-code-sent'));

  const box = h('div', { class: 'login' });
  const draw = () => {
    clear(box);
    if (!codeSent) {
      const input = h('input', { type: 'email', id: 'email', autocomplete: 'email', inputmode: 'email', required: true, value: email, placeholder: 'you@example.com' });
      const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'Email me a code');
      const form = h('form', { class: 'card' },
        h('label', { for: 'email' }, 'Email'), input, btn,
        h('p', { class: 'muted small' }, 'Members only. No passwords — we email you an 8-digit code that works once and expires in 10 minutes.'));
      form.addEventListener('submit', busy(btn, async () => {
        email = input.value.trim().toLowerCase();
        if (!email) return;
        await api.requestCode(email);
        store.set('mk-login-email', email);
        store.set('mk-code-sent', Date.now());
        codeSent = true;
        draw();
      }));
      box.append(form);
      setTimeout(() => input.focus(), 50);
    } else {
      const input = h('input', { id: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]{8}', maxlength: '8', required: true, placeholder: '12345678', class: 'code-input' });
      const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'Sign in');
      const resend = h('button', { type: 'button', class: 'btn link' }, 'Resend code');
      resend.addEventListener('click', busy(resend, async () => { await api.requestCode(email); toast('New code sent'); }));
      const form = h('form', { class: 'card' },
        h('p', {}, 'If ', h('strong', {}, email), ' is on the member list, a code is on its way.'),
        h('label', { for: 'code' }, '8-digit code'), input, btn,
        h('div', { class: 'row-between' },
          h('button', { type: 'button', class: 'btn link', onclick: () => { codeSent = false; store.del('mk-code-sent'); draw(); } }, 'Use a different email'),
          resend));
      input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, '').slice(0, 8); if (input.value.length === 8) form.requestSubmit(); });
      form.addEventListener('submit', busy(btn, async () => {
        await api.verifyCode(email, input.value);
        store.del('mk-code-sent');
        await boot();
      }));
      box.append(form);
      setTimeout(() => input.focus(), 50);
    }
  };
  clear(view).append(h('div', { class: 'hero' }, h('div', { class: 'hero-mark', 'aria-hidden': 'true' }, '🏆'), h('h1', {}, CONFIG.APP_NAME), h('p', { class: 'muted' }, 'Mario Kart Wii VS scores for the group.')), box);
  draw();
}

// =================================================================== events
async function viewEvents() {
  page('Events', spinner());
  const events = await api.listEvents();
  const form = newEventForm();
  const list = events.length
    ? h('div', { class: 'list' }, events.map((e) => {
        const confirmed = e.grand_prix.filter((g) => g.status === 'confirmed').length;
        return h('a', { class: 'list-item', href: `#/events/${e.id}` },
          h('div', {}, h('div', { class: 'li-title' }, e.name),
            h('div', { class: 'li-sub' }, [e.kind, e.location, fmtDate(e.starts_on)].filter(Boolean).join(' · '))),
          h('span', { class: 'pill' }, `${confirmed}/${e.grand_prix.length} VS`));
      }))
    : emptyState('No events yet', 'Create one for your next session, weekend or trip.');
  page('Events', form, list);
}

function newEventForm() {
  const name = h('input', { id: 'ev-name', required: true, maxlength: '120', placeholder: 'Lake house weekend' });
  const kind = selectEl(EVENT_KINDS.map((k) => ({ value: k, label: k[0].toUpperCase() + k.slice(1) })), 'session', { id: 'ev-kind' });
  const date = h('input', { id: 'ev-date', type: 'date', value: new Date().toISOString().slice(0, 10) });
  const loc = h('input', { id: 'ev-loc', maxlength: '120', placeholder: 'Optional' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Create event');
  const form = h('form', { class: 'card collapsible' },
    h('details', {},
      h('summary', { class: 'btn primary block' }, '+ New event'),
      h('div', { class: 'stack' },
        h('label', { for: 'ev-name' }, 'Name'), name,
        h('div', { class: 'grid-2' },
          h('div', {}, h('label', { for: 'ev-kind' }, 'Type'), kind),
          h('div', {}, h('label', { for: 'ev-date' }, 'Date'), date)),
        h('label', { for: 'ev-loc' }, 'Location'), loc, btn)));
  form.addEventListener('submit', busy(btn, async () => {
    const ev = await api.createEvent({ name: name.value.trim(), kind: kind.value, starts_on: date.value || null, location: loc.value.trim() || null });
    toast('Event created');
    go(`#/events/${ev.id}`);
  }));
  return form;
}

async function viewEvent(id) {
  page('Event', spinner());
  const [ev, gps] = await Promise.all([api.getEvent(id), api.listGps(id)]);
  const confirmed = gps.filter((g) => g.status === 'confirmed');

  const cls = selectEl(ENGINE_CLASSES, '150cc', { id: 'gp-class' });
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, '+ New VS session (4 races)');
  const form = h('form', { class: 'card' },
    h('label', { for: 'gp-class' }, 'Class'), cls,
    h('p', { class: 'muted small' }, 'Versus mode: 4 races on random tracks. Only the players are tracked, not CPUs.'),
    btn);
  form.addEventListener('submit', busy(btn, async () => {
    const gp = await api.createGp({ event_id: id, engine_class: cls.value });
    go(`#/gp/${gp.id}`);
  }));

  const gpList = gps.length
    ? h('div', { class: 'list' }, gps.map((g) => {
        const winner = g.participants.find((p) => p.final_place === 1);
        return h('a', { class: 'list-item', href: `#/gp/${g.id}` },
          h('div', {},
            h('div', { class: 'li-title' }, gpTitle(g)),
            h('div', { class: 'li-sub' }, g.status === 'confirmed'
              ? `${g.engine_class} · 🏆 ${winner ? winner.label : '—'} ${winner ? `(${winner.final_total})` : ''}`
              : `${g.engine_class} · waiting for scores`)),
          h('span', { class: `pill ${g.status === 'confirmed' ? 'ok' : 'warn'}` }, g.status === 'confirmed' ? 'Confirmed' : 'Draft'));
      }))
    : emptyState('No VS sessions yet', 'Start one, race 4 times, then upload the scores.');

  const standings = confirmed.length
    ? h('section', {}, h('h2', {}, 'Event power rankings'), powerTable(powerRankings(confirmed, state.profiles)),
        h('a', { class: 'btn block', href: `#/stats/${id}` }, 'Full event analytics →'))
    : null;

  const canDelete = ev.created_by === state.me.profile.id || state.me.isAdmin;
  const del = canDelete ? h('button', { class: 'btn danger-link' }, 'Delete event') : null;
  if (del) del.addEventListener('click', busy(del, async () => {
    if (!confirm(`Delete "${ev.name}" and all of its VS sessions? This cannot be undone.`)) return;
    await api.deleteEvent(id);
    toast('Event deleted');
    go('#/events');
  }));

  page(ev.name,
    h('p', { class: 'muted' }, [ev.kind, ev.location, fmtDate(ev.starts_on)].filter(Boolean).join(' · ')),
    standings, h('h2', {}, 'VS sessions'), gpList, form, del);
}

// ======================================================================= GP
async function viewGp(id) {
  page('VS session', spinner());
  const gp = await api.getGp(id);
  if (gp.status !== 'confirmed') return viewGpEntry(gp);

  const title = gpTitle(gp);
  const parts = gp.participants;
  const results = table(['', 'Player', 'Char', 'Pts'], parts.map((p) => [
    medal(p.final_place), h('span', {}, p.profile_id ? h('strong', {}, p.label) : p.label, p.is_cpu ? h('span', { class: 'tag' }, 'CPU') : null, !p.profile_id && !p.is_cpu ? h('span', { class: 'tag' }, 'guest') : null),
    charBadge(p.character), h('strong', {}, p.final_total)]), { stickyFirst: false, cls: 'results' });

  let raceTable = null;
  if (gp.entry_mode === 'races') {
    raceTable = h('section', {}, h('h2', {}, 'Race by race'),
      table(['Player', ...gp.races.map((r) => `R${r.race_number}`), 'Total'], parts.map((p) => [
        p.label,
        ...gp.races.map((r) => { const x = r.results.find((q) => q.participant_id === p.id); return x ? `${ordinal(x.placement)} · ${x.points}` : '—'; }),
        h('strong', {}, p.final_total)])),
      gp.races.some((r) => r.track) ? h('ol', { class: 'track-list' }, gp.races.map((r) => h('li', {}, r.track || 'track not recorded'))) : null);
  }

  const photoPaths = gp.uploads.flatMap((u) => u.image_paths);
  const photos = h('div', { class: 'photo-strip' });
  if (photoPaths.length) api.signedUrls(photoPaths).then((urls) => photos.append(...urls.map((u) => h('a', { href: u, target: '_blank', rel: 'noopener' }, h('img', { src: u, alt: 'Score screen photo', loading: 'lazy' })))));

  const actions = h('div', { class: 'stack' });
  if (!gp.summary_sent_at) {
    const b = h('button', { class: 'btn primary block' }, 'Email the summary to everyone');
    b.addEventListener('click', busy(b, async () => { await api.sendSummary(gp.id); toast('Summary emailed'); viewGp(id); }));
    actions.append(h('p', { class: 'warn-text' }, 'The summary email has not gone out yet.'), b);
  } else {
    actions.append(h('p', { class: 'muted small' }, `Confirmed ${fmtDateTime(gp.confirmed_at)} by ${profileName(gp.confirmed_by)} · summary emailed ${fmtDateTime(gp.summary_sent_at)}`));
  }
  if (state.me.isAdmin) {
    const b = h('button', { class: 'btn danger-link' }, 'Reopen for correction (admin)');
    b.addEventListener('click', busy(b, async () => {
      if (!confirm('Reopen this VS session? Its results are removed until it is confirmed again.')) return;
      await api.reopenGp(gp.id); toast('Reopened'); viewGp(id);
    }));
    actions.append(b);
  }

  page(title,
    h('p', { class: 'muted' }, h('a', { href: `#/events/${gp.event_id}` }, `← ${gp.events?.name ?? 'Event'}`), ` · ${gp.engine_class} · ${gp.entry_mode === 'races' ? '4 races entered' : 'final totals'}`),
    results, raceTable, photoPaths.length ? h('section', {}, h('h2', {}, 'Photos'), photos) : null, actions);
}

const gpTitle = (g) => `VS ${g.seq}${g.cup ? ` · ${g.cup} Cup` : ''}`;
const medal = (place) => h('span', { class: `place place-${place}` }, place <= 3 ? ['🥇', '🥈', '🥉'][place - 1] : ordinal(place));

// --------------------------------------------------------- score entry view
function viewGpEntry(gp) {
  const key = `mk-draft-${gp.id}`;
  const saved = store.get(key);
  let draft = saved?.draft || emptyDraft();
  let extras = saved?.extras || [];
  let tab = saved?.tab || 'total';
  let raceTab = 0;
  const icons = new Map(); // participant key → icon canvas (from photo analysis)
  const photo = { kind: 'final', files: [null, null, null, null], analysis: null, colorCanvases: [] };

  const persist = () => store.set(key, { draft, tab, extras });
  const body = h('div', {});
  const summary = h('div', { class: 'summary', 'aria-live': 'polite' });

  function setTab(t) {
    tab = t;
    if (t === 'total' || t === 'races') {
      draft.mode = t;
      if (!draft.source.startsWith('photo')) draft.source = t === 'races' ? 'manual_races' : 'manual_total';
      else draft.source = t === 'races' ? 'photo_races' : 'photo_total';
    }
    persist();
    render();
  }

  const tabs = () => h('div', { class: 'segmented', role: 'tablist', 'aria-label': 'Entry method' },
    [['total', 'Final totals'], ['races', 'All 4 races'], ['photo', '📷 Photo']].map(([t, label]) =>
      h('button', { type: 'button', role: 'tab', 'aria-selected': String(tab === t), class: tab === t ? 'on' : '', onclick: () => setTab(t) }, label)));

  // ---- karts
  function kartEditor() {
    const members = state.profiles;
    const used = new Set(draft.participants.map((p) => p.profile_id).filter(Boolean));
    const rows = draft.participants.map((p, i) => {
      const who = selectEl([
        ...members.map((m) => ({ value: m.id, label: m.display_name, disabled: used.has(m.id) && m.id !== p.profile_id })),
        { value: '__guest', label: 'Guest (not a member)' },
      ], p.profile_id || '__guest', { 'aria-label': `Player ${i + 1}` });
      who.addEventListener('change', () => {
        const v = who.value;
        if (v === '__guest') {
          p.profile_id = null; p.is_cpu = false;
          if (!p.label || members.some((m) => m.display_name === p.label)) p.label = 'Guest';
        } else {
          const m = members.find((x) => x.id === v);
          p.profile_id = v; p.is_cpu = false; p.label = m.display_name;
          if (!p.character && m.favorite_character) p.character = m.favorite_character;
        }
        persist(); render();
      });
      const label = h('input', { value: p.label, maxlength: '40', 'aria-label': `Kart ${i + 1} name`, disabled: Boolean(p.profile_id) });
      label.addEventListener('change', () => { p.label = label.value; persist(); refresh(); });
      const ch = selectEl([{ value: '', label: 'Character…' }, ...CHARACTERS], p.character || '', { 'aria-label': `Kart ${i + 1} character` });
      ch.addEventListener('change', () => { p.character = ch.value || null; persist(); });
      const rm = h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Remove kart ${i + 1}`, onclick: () => {
        draft.participants.splice(i, 1);
        draft.races.forEach((r) => delete r.results[p.key]);
        persist(); render();
      } }, '✕');
      const hint = p.suggestion && (p.suggestion.profile_id || p.suggestion.is_cpu)
        ? h('p', { class: 'hint' }, `📷 read "${p.ocr_name || '?'}" → `, p.suggestion.is_cpu ? 'CPU' : `${profileName(p.suggestion.profile_id)} (${Math.round(p.suggestion.confidence * 100)}%)`, ' — ', p.suggestion.reasons.join('; '))
        : p.ocr_name ? h('p', { class: 'hint warn-text' }, `📷 read "${p.ocr_name}" — no match, choose the driver`) : null;
      const icon = icons.get(p.key);
      return h('div', { class: 'kart' },
        h('div', { class: 'kart-head' }, h('span', { class: 'kart-no' }, i + 1), icon ? h('span', { class: 'icon-crop' }, cloneCanvas(icon)) : null, who, rm),
        h('div', { class: 'grid-2' }, label, ch), hint);
    });

    const addMember = h('button', { type: 'button', class: 'btn', onclick: () => {
      const m = members.find((x) => !used.has(x.id));
      draft.participants.push(m
        ? makeParticipant({ profile_id: m.id, label: m.display_name, character: m.favorite_character })
        : makeParticipant({ label: 'Guest' }));
      persist(); render();
    } }, '+ Player');
    const addAll = h('button', { type: 'button', class: 'btn', onclick: () => {
      members.filter((m) => !used.has(m.id)).slice(0, MAX_PLAYERS - draft.participants.length)
        .forEach((m) => draft.participants.push(makeParticipant({ profile_id: m.id, label: m.display_name, character: m.favorite_character })));
      persist(); render();
    } }, 'Add all members');
    const full = draft.participants.length >= MAX_PLAYERS;
    [addMember, addAll].forEach((b) => { b.disabled = full; });
    // Rows the photo reader judged to be CPUs: one tap adds a missed player back.
    const cpuRows = extras.length
      ? h('details', { class: 'card tight' },
          h('summary', {}, `Rows read as CPUs (${extras.length}) — not tracked`),
          h('p', { class: 'muted small' }, 'If one of these was actually a player, add it.'),
          h('div', { class: 'list' }, extras.map((x) => {
            const b = h('button', { type: 'button', class: 'btn small' }, 'Add as player');
            b.addEventListener('click', () => {
              addExtraAsPlayer(draft, x);
              extras = extras.filter((e) => e.key !== x.key);
              persist(); render();
            });
            const detail = draft.mode === 'races' ? (x.places || []).map((pl) => (pl ? ordinal(pl) : '—')).join(' · ') : `${x.final_total ?? '—'} pts`;
            return h('div', { class: 'list-item static' }, h('div', {}, h('div', { class: 'li-title' }, `${ordinal(x.place)} · ${x.name || 'unread'}`), h('div', { class: 'li-sub' }, detail)), b);
          })))
      : null;
    return h('section', {}, h('h2', {}, `Players (${draft.participants.length})`), rows.length ? rows : h('p', { class: 'muted' }, 'Add the players who raced (usually 4). CPUs aren\u2019t tracked.'), h('div', { class: 'btn-row' }, addMember, addAll), cpuRows);
  }

  // ---- final totals
  function totalsEditor() {
    if (!draft.participants.length) return null;
    return h('section', {}, h('h2', {}, 'Final totals'), h('p', { class: 'muted small' }, `GP points after race 4 (0–${MAX_GP_TOTAL}).`),
      h('div', { class: 'totals' }, draft.participants.map((p) => {
        const inp = h('input', { type: 'number', inputmode: 'numeric', min: '0', max: String(MAX_GP_TOTAL), step: '1', value: p.final_total ?? '', 'aria-label': `${p.label} total` });
        inp.addEventListener('input', () => { p.final_total = inp.value === '' ? null : Number(inp.value); persist(); refresh(); });
        return h('label', { class: 'total-row' }, h('span', {}, p.label || 'Kart'), inp);
      })));
  }

  // ---- race by race
  function racesEditor() {
    if (!draft.participants.length) return null;
    const n = draft.participants.length;
    const done = completedRaceCount(draft);
    const race = draft.races[raceTab];
    const trackSel = selectEl([{ value: '', label: 'Track (optional)' }, ...ALL_TRACKS], race.track || '', { 'aria-label': `Race ${raceTab + 1} track` });
    trackSel.addEventListener('change', () => { race.track = trackSel.value; persist(); refresh(); });
    const taken = Object.values(race.results);
    const rows = draft.participants.map((p) => {
      const cur = race.results[p.key];
      const sel = selectEl([{ value: '', label: '—' }, ...Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: `${ordinal(i + 1)}${taken.includes(i + 1) && cur !== i + 1 ? ' (taken)' : ''} · ${pointsFor(i + 1)} pts` }))], cur ?? '', { 'aria-label': `${p.label} placement in race ${raceTab + 1}` });
      sel.addEventListener('change', () => { if (sel.value) race.results[p.key] = Number(sel.value); else delete race.results[p.key]; persist(); render(); });
      const dup = cur && taken.filter((x) => x === cur).length > 1;
      return h('label', { class: `total-row ${dup ? 'bad' : ''}` }, h('span', {}, p.label || 'Kart'), sel);
    });
    return h('section', {},
      h('h2', {}, 'Race results'),
      h('p', { class: 'muted small' }, 'Each player\u2019s finishing place out of all 12 karts (CPUs included), so points match the game.'),
      h('div', { class: `banner ${done === RACES_PER_GP ? 'ok' : 'warn'}` },
        done === RACES_PER_GP
          ? '✓ All 4 races complete — totals are calculated for you.'
          : h('span', {}, `${done} of ${RACES_PER_GP} races complete. Race-by-race scores are only accepted with all 4 races. `,
              h('button', { type: 'button', class: 'btn link', onclick: () => setTab('total') }, 'Missing a race? Enter final totals instead.'))),
      h('div', { class: 'segmented small', role: 'tablist', 'aria-label': 'Race' }, draft.races.map((r, i) =>
        h('button', { type: 'button', role: 'tab', 'aria-selected': String(raceTab === i), class: raceTab === i ? 'on' : '', onclick: () => { raceTab = i; render(); } },
          `R${i + 1} ${isRaceComplete(r, draft.participants) ? '✓' : ''}`))),
      h('div', { class: 'card tight' }, h('label', {}, 'Track'), trackSel, h('div', { class: 'totals' }, rows)),
      raceTab < RACES_PER_GP - 1 ? h('button', { type: 'button', class: 'btn block', onclick: () => { raceTab++; render(); } }, `Next: race ${raceTab + 2} →`) : null);
  }

  // ---- photo
  function photoEditor() {
    const slots = photo.kind === 'final' ? [0] : [0, 1, 2, 3];
    const filled = slots.filter((i) => photo.files[i]).length;
    const needed = slots.length;
    const kindSel = h('div', { class: 'segmented small', role: 'radiogroup', 'aria-label': 'Which screen' },
      [['final', 'Final results (1 photo)'], ['race', '4 after-race screens']].map(([k, label]) =>
        h('button', { type: 'button', role: 'radio', 'aria-checked': String(photo.kind === k), class: photo.kind === k ? 'on' : '', onclick: () => { if (photo.kind !== k) { photo.kind = k; photo.files = [null, null, null, null]; photo.analysis = null; } render(); } }, label)));

    const slotEls = slots.map((i) => {
      const input = h('input', { type: 'file', accept: 'image/*', id: `ph-${i}`, class: 'visually-hidden' });
      input.addEventListener('change', () => { photo.files[i] = input.files[0] || null; photo.analysis = null; render(); });
      const f = photo.files[i];
      const label = photo.kind === 'final' ? '"You got … place!" results screen' : `After race ${i + 1} — the screen with +points`;
      return h('label', { class: `photo-slot ${f ? 'has' : ''}`, for: `ph-${i}` },
        f ? h('img', { src: URL.createObjectURL(f), alt: label }) : h('span', { class: 'slot-plus', 'aria-hidden': 'true' }, '+'),
        h('span', { class: 'slot-label' }, f ? `✓ ${label}` : `Take or choose: ${label}`), input);
    });

    const analyze = h('button', { type: 'button', class: 'btn primary block', disabled: filled < needed }, 'Analyze photo' + (needed > 1 ? 's' : ''));
    const progress = h('div', { class: 'progress', hidden: true }, h('div', { class: 'bar' }), h('span', { class: 'progress-label' }));
    analyze.addEventListener('click', busy(analyze, async () => {
      const vision = await import('./vision.js');
      progress.hidden = false;
      const setP = (frac, label) => { progress.querySelector('.bar').style.width = `${Math.round(frac * 100)}%`; progress.querySelector('.progress-label').textContent = label; };
      const templates = await api.loadTemplates().catch(() => []);
      const miiNames = state.profiles.map((p) => p.mii_name).filter(Boolean);
      const screens = [];
      photo.colorCanvases = [];
      for (const [n, i] of slots.entries()) {
        const res = await vision.analyzePhoto(photo.files[i], {
          miiNames,
          templates,
          onProgress: (p) => setP((n + p.progress) / slots.length, `${slots.length > 1 ? `Photo ${n + 1}/${slots.length}: ` : ''}${p.status}`),
        });
        screens.push(res);
        photo.colorCanvases.push(res.canvas);
      }
      const base = screens[0];
      const identities = suggestIdentities(base.rows, state.profiles);
      const { draft: d, issues, extras: ex } = draftFromScreens({ screens, identities, profiles: state.profiles });
      extras = ex;
      icons.clear();
      for (const p of [...d.participants, ...ex]) { const c = base.rows[p.row_index]?.iconCanvas; if (c) icons.set(p.key, c); }
      d.ocr_raw = {
        engine: base.engine,
        screens: screens.map((s) => ({ kind: s.kind, phase: s.phase, issues: s.issues, rows: s.rows.map(({ place, name, points, gained, human, character, characterConfidence, characterSource, confidence }) => ({ place, name, points, gained, human, character, characterConfidence, characterSource, confidence })) })),
        suggestions: identities,
      };
      photo.analysis = { screens, issues: [...screens.flatMap((s, i) => s.issues.map((x) => (screens.length > 1 ? `Photo ${i + 1}: ${x}` : x))), ...issues] };
      draft = d;
      tab = d.mode;
      persist();
      toast(`Found ${d.participants.length} player${d.participants.length === 1 ? '' : 's'} — check them below, then confirm.`);
      render();
    }));

    return h('section', {},
      h('h2', {}, 'Upload a photo'),
      h('p', { class: 'muted small' }, 'Mario Kart Wii only. Photograph the TV as straight on as you can, with the whole list in the frame. Everything is read on your phone — it takes 20-40 seconds per photo, and you check every row before confirming.'),
      kindSel, h('div', { class: `photo-grid n${slots.length}` }, slotEls),
      filled < needed && photo.kind === 'race'
        ? h('div', { class: 'banner warn' }, `${filled} of 4 race photos added. Individual race uploads need all 4 races. `,
            h('button', { type: 'button', class: 'btn link', onclick: () => { photo.kind = 'final'; photo.files = [null, null, null, null]; render(); } }, 'Only have the final screen? Use that instead.'))
        : null,
      analyze, progress);
  }

  function analysisPanel() {
    if (!photo.analysis) return null;
    const s = photo.analysis.screens[0];
    const cv = cloneCanvas(photo.colorCanvases[0]);
    const ctx = cv.getContext('2d');
    ctx.lineWidth = Math.max(2, cv.width / 400);
    const box = (b, color) => { if (b) { ctx.strokeStyle = color; ctx.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0); } };
    for (const r of s.rows) {
      box(r.nameBox, r.human ? '#22c55e' : '#94a3b8');
      box(r.pointsBox, '#f59e0b');
    }
    cv.classList.add('analysis-canvas');
    return h('details', { class: 'card', open: photo.analysis.issues.length > 0 },
      h('summary', {}, `Photo analysis · ${s.kind === 'final' ? 'final results' : s.phase === 'race' ? 'after-race screen' : 'standings'} · ${s.rows.filter((r) => r.human).length} players spotted`),
      cv,
      photo.analysis.issues.length ? h('ul', { class: 'issues' }, photo.analysis.issues.map((x) => h('li', {}, x))) : h('p', { class: 'ok-text' }, 'No problems spotted.'),
      h('p', { class: 'muted small' }, 'Green = player bar, grey = CPU, orange = where the total was read.'),
      table(['#', 'Read', 'Player?', 'Pts'], s.rows.map((r) => [r.place, r.name || '—', r.human ? 'yes' : '', r.points ?? '—']), { stickyFirst: false }));
  }

  // ---- review + confirm
  const confirmBtn = h('button', { type: 'button', class: 'btn primary block big' }, 'Confirm & email everyone');
  confirmBtn.addEventListener('click', busy(confirmBtn, async () => {
    const payload = toPayload(draft);
    if (!confirm(`Confirm VS ${gp.seq} (${draft.mode === 'races' ? '4 races' : 'final totals'}) and email the summary to every member?`)) return;
    if (photo.analysis) {
      confirmBtn.textContent = 'Uploading photos…';
      const vision = await import('./vision.js');
      const paths = [];
      for (const [i, c] of photo.colorCanvases.entries()) {
        paths.push(await api.uploadPhoto(gp.id, await vision.compressForUpload(c), photo.kind === 'final' ? 'final' : `race${i + 1}`));
      }
      payload.image_paths = paths;
    }
    confirmBtn.textContent = 'Saving…';
    await api.submitGp(gp.id, payload);
    store.del(key);
    const teach = draft.participants.filter((p) => p.character && icons.get(p.key)).map((p) => ({ character: p.character, canvas: icons.get(p.key) }));
    if (teach.length) api.saveTemplates(teach, state.me.profile.id).catch((e) => console.warn('template save failed', e));
    confirmBtn.textContent = 'Emailing…';
    try {
      await api.sendSummary(gp.id);
      toast('Confirmed and emailed 🎉');
    } catch (e) {
      toast(`Confirmed. ${e.message} — you can resend from the session page.`, 'error');
    }
    go(`#/gp/${gp.id}`);
  }));

  function refresh() {
    const v = validateDraft(draft);
    const standings = draft.participants.length ? computeStandings(draft) : [];
    clear(summary).append(...[
      h('h2', {}, 'Review'),
      standings.length ? table(['', 'Player', 'Total'], standings.map((r) => [medal(r.place), r.label || '—', h('strong', {}, r.total)]), { stickyFirst: false, cls: 'results' }) : null,
      v.ok ? null : h('ul', { class: 'issues' }, v.errors.map((e) => h('li', {}, e))),
    ].filter(Boolean));
    confirmBtn.disabled = !v.ok || tab === 'photo';
  }

  function render() {
    clear(body).append(...[
      tabs(),
      tab === 'photo' ? photoEditor() : null,
      analysisPanel(),
      tab !== 'photo' ? kartEditor() : null,
      tab === 'total' ? totalsEditor() : null,
      tab === 'races' ? racesEditor() : null,
      tab !== 'photo' ? summary : null,
      tab !== 'photo' ? h('div', { class: 'sticky-action' }, confirmBtn) : null,
    ].filter(Boolean));
    refresh();
  }

  const canDelete = gp.created_by === state.me.profile.id || state.me.isAdmin;
  const del = canDelete ? h('button', { class: 'btn danger-link' }, 'Delete this draft session') : null;
  if (del) del.addEventListener('click', busy(del, async () => {
    if (!confirm('Delete this VS session?')) return;
    await api.deleteGp(gp.id); store.del(key); go(`#/events/${gp.event_id}`);
  }));

  page(gpTitle(gp),
    h('p', { class: 'muted' }, h('a', { href: `#/events/${gp.event_id}` }, `← ${gp.events?.name ?? 'Event'}`), ` · ${gp.engine_class} · enter scores`),
    body, del);
  render();
}

function cloneCanvas(src) {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

// ==================================================================== stats
function powerTable(rows) {
  return table(['Player', 'Power', 'GPs', 'Avg pts', 'Avg place', 'Wins', 'Podium', 'Form'],
    rows.map((r) => [`${r.rank}. ${r.name}`, h('strong', {}, r.power), r.gps, r.avgPts, r.avgPlace, `${r.winRate}%`, `${r.podiumRate}%`, r.form]));
}

async function viewStats(eventId) {
  page('Stats', spinner());
  const [events, gps] = await Promise.all([api.listEvents(), api.confirmedGps(eventId || undefined)]);
  const scope = selectEl([{ value: '', label: 'All time (lifetime)' }, ...events.map((e) => ({ value: e.id, label: e.name }))], eventId || '', { 'aria-label': 'Scope' });
  scope.addEventListener('change', () => go(scope.value ? `#/stats/${scope.value}` : '#/stats'));
  const header = h('div', { class: 'card tight' }, h('label', {}, 'Showing'), scope);
  if (!gps.length) return page('Stats', header, emptyState('No confirmed sessions yet', 'Stats appear once scores are confirmed.'));

  const P = state.profiles;
  const power = powerRankings(gps, P);
  const elo = eloRatings(gps, P);
  const cons = consistencyMetrics(gps, P);
  const tracks = trackStats(gps, P);
  const h2hM = headToHeadMatrix(gps, P);
  const ins = insights(gps, P);
  const raceGps = gps.filter((g) => g.entry_mode === 'races').length;

  // Head-to-head picker
  const players = h2hM.players;
  const aSel = selectEl(players.map((p) => ({ value: p.id, label: p.name })), players[0]?.id, { 'aria-label': 'Player A' });
  const bSel = selectEl(players.map((p) => ({ value: p.id, label: p.name })), players[1]?.id, { 'aria-label': 'Player B' });
  const h2hOut = h('div', {});
  const drawH2h = () => {
    const a = aSel.value; const b = bSel.value;
    if (!a || !b || a === b) return clear(h2hOut).append(h('p', { class: 'muted' }, 'Pick two different players.'));
    const r = headToHead(gps, a, b);
    clear(h2hOut).append(r.gps
      ? h('div', { class: 'h2h' },
          h('div', { class: 'h2h-score' }, h('span', {}, profileName(a)), h('strong', {}, `${r.aWins} – ${r.bWins}`), h('span', {}, profileName(b))),
          h('p', { class: 'muted small' }, `${r.gps} GPs together${r.ties ? `, ${r.ties} tied` : ''} · avg margin ${r.avgMargin > 0 ? '+' : ''}${r.avgMargin} pts for ${profileName(a)}`),
          r.races ? h('p', { class: 'muted small' }, `Races: ${r.aRaceWins} – ${r.bRaceWins} (${r.races} head-to-head races)`) : null)
      : h('p', { class: 'muted' }, 'These two haven’t raced in the same session yet.'));
  };
  aSel.addEventListener('change', drawH2h); bSel.addEventListener('change', drawH2h); drawH2h();

  // Track filter
  const trackPlayer = selectEl([{ value: '', label: 'Everyone' }, ...players.map((p) => ({ value: p.id, label: p.name }))], '', { 'aria-label': 'Track table player' });
  const trackOut = h('div', {});
  const drawTracks = () => {
    const rows = tracks.perTrack.filter((t) => !trackPlayer.value || t.profile_id === trackPlayer.value).sort((x, y) => x.track.localeCompare(y.track) || x.avgPlace - y.avgPlace);
    clear(trackOut).append(rows.length ? table(['Track', 'Player', 'Races', 'Avg place', 'Avg pts'], rows.map((t) => [t.track, t.name, t.races, t.avgPlace, t.avgPoints])) : h('p', { class: 'muted' }, 'No race-by-race data yet.'));
  };
  trackPlayer.addEventListener('change', drawTracks); drawTracks();

  const section = (title, note, ...content) => h('section', { class: 'card' }, h('h2', {}, title), note ? h('p', { class: 'muted small' }, note) : null, ...content);

  page('Stats', header,
    h('p', { class: 'muted small' }, `${gps.length} confirmed VS session${gps.length === 1 ? '' : 's'} · ${raceGps} with race-by-race detail`),
    section('Power rankings', 'Blend of points share (45%), finishing place vs. field (30%), win rate (15%) and recent form (10%), shrunk toward the group average for players with few GPs.', powerTable(power)),
    section('Skill rating (Elo)', 'Every session counts as head-to-head duels between players by final total. Starts at 1500.',
      table(['Player', 'Elo', 'GPs'], elo.map((r) => [`${r.rank}. ${r.name}`, h('strong', {}, r.elo), r.gps]))),
    section('Consistency', 'Consistency 0-100: 100 = same place every race, 50 = as scattered as a random finisher. Volatility = average swing in total between consecutive sessions.',
      table(['Player', 'Consistency', 'GP σ', 'CV', 'Volatility', 'Race σ'], cons.map((c) => [c.name, h('strong', {}, c.consistency ?? '—'), c.gpStdev ?? '—', c.cv ?? '—', c.volatility ?? '—', c.raceStdev ?? '—']))),
    section('Head to head', null, h('div', { class: 'grid-2' }, aSel, bSel), h2hOut,
      h('details', {}, h('summary', {}, 'Win % matrix (row vs column)'), h2hMatrixTable(h2hM))),
    section('Best & worst tracks', 'Average race placement (needs race-by-race GPs).',
      tracks.bestWorst.length ? h('div', { class: 'bw-grid' }, tracks.bestWorst.map((p) => h('div', { class: 'bw' },
        h('h3', {}, p.name),
        h('p', { class: 'ok-text small' }, '▲ ', p.best.map((t) => `${t.track} (${t.avgPlace})`).join(', ')),
        h('p', { class: 'warn-text small' }, '▼ ', p.worst.map((t) => `${t.track} (${t.avgPlace})`).join(', '))))) : h('p', { class: 'muted' }, 'No race-by-race data yet.'),
      tracks.trackKings.length ? h('details', {}, h('summary', {}, 'Track kings'), table(['Track', 'King', 'Avg place', 'Races'], tracks.trackKings.map((t) => [t.track, t.king, t.avgPlace, t.races]))) : null),
    section('Average placement per track', null, h('div', { class: 'card tight' }, trackPlayer), trackOut),
    section('More insights', 'Clutch = race 4 avg placement minus races 1-3 (negative finishes strong). Comebacks = session wins after 4th or worse (of 12) in race 1.',
      table(['Player', 'Best session', '60s', 'Win streak', 'Clutch', 'Comebacks', 'Best character'], ins.map((x) => [x.name, x.bestGp, x.perfectGps, x.winStreak, x.clutch ?? '—', x.comebacks, x.characters[0] ? `${x.characters[0].character} (${x.characters[0].avgPts})` : '—']))));
}

function h2hMatrixTable(m) {
  const cell = (a, b) => {
    if (a === b) return '—';
    const c = m.cells.find((x) => x.a === a && x.b === b);
    return c ? `${c.winPct}%` : '·';
  };
  return table(['', ...m.players.map((p) => p.name)], m.players.map((p) => [p.name, ...m.players.map((q) => cell(p.id, q.id))]));
}

// ======================================================================= me
function viewMe() {
  const p = state.me.profile;
  const name = h('input', { id: 'me-name', value: p.display_name, maxlength: '40', required: true });
  const mii = h('input', { id: 'me-mii', value: p.mii_name || '', maxlength: '20', placeholder: 'As shown on the Wii' });
  const fav = selectEl([{ value: '', label: 'Choose…' }, ...CHARACTERS], p.favorite_character || '', { id: 'me-fav' });
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'Save');
  const form = h('form', { class: 'card' },
    h('label', { for: 'me-name' }, 'Display name'), name,
    h('label', { for: 'me-mii' }, 'Mii name'), mii,
    h('p', { class: 'muted small' }, 'Used to recognise you in score-screen photos.'),
    h('label', { for: 'me-fav' }, 'Favourite character'), fav,
    h('p', { class: 'muted small' }, 'When a photo shows this character, we suggest it was you.'), btn);
  form.addEventListener('submit', busy(btn, async () => {
    state.me.profile = await api.updateProfile(p.id, { display_name: name.value.trim(), mii_name: mii.value.trim() || null, favorite_character: fav.value || null });
    state.profiles = await api.listProfiles();
    toast('Saved');
  }));
  const out = h('button', { class: 'btn block' }, 'Sign out');
  out.addEventListener('click', busy(out, async () => { await api.signOut(); state.me = null; go('#/login'); }));
  page('Me', h('p', { class: 'muted' }, p.email), form, out);
}

// ==================================================================== admin
async function viewAdmin() {
  if (!state.me.isAdmin) return go('#/events');
  page('Members', spinner());
  const list = await api.listApproved();
  const email = h('input', { id: 'add-email', type: 'email', inputmode: 'email', required: true, placeholder: 'friend@example.com' });
  const admin = h('input', { id: 'add-admin', type: 'checkbox' });
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'Approve email');
  const form = h('form', { class: 'card' }, h('label', { for: 'add-email' }, 'Add a member'), email,
    h('label', { class: 'check' }, admin, ' Make admin'), btn,
    h('p', { class: 'muted small' }, 'They can sign in with this email right away. Removing someone blocks all access immediately.'));
  form.addEventListener('submit', busy(btn, async () => {
    await api.addApproved(email.value, admin.checked, state.me.profile.id);
    toast(`${email.value} approved`);
    viewAdmin();
  }));
  const rows = h('div', { class: 'list' }, list.map((u) => {
    const isMe = u.email.toLowerCase() === state.me.session.user.email.toLowerCase();
    const toggle = h('button', { class: 'btn small' }, u.is_admin ? 'Remove admin' : 'Make admin');
    toggle.addEventListener('click', busy(toggle, async () => { await api.setAdmin(u.email, !u.is_admin); viewAdmin(); }));
    const rm = h('button', { class: 'btn small danger', disabled: isMe }, 'Remove');
    rm.addEventListener('click', busy(rm, async () => {
      if (!confirm(`Remove ${u.email}? Their past results stay in the stats.`)) return;
      await api.removeApproved(u.email); toast('Removed'); viewAdmin();
    }));
    return h('div', { class: 'list-item static' },
      h('div', {}, h('div', { class: 'li-title' }, u.email), h('div', { class: 'li-sub' }, `${u.is_admin ? 'Admin · ' : ''}since ${fmtDate(u.added_at)}`)),
      h('div', { class: 'btn-row tight' }, toggle, rm));
  }));
  page('Members', form, h('h2', {}, `Approved (${list.length})`), rows);
}

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
  if (!state.me) return viewLogin();
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
  const me = await api.loadMe(session);
  if (!me.approved) {
    await api.signOut();
    state.me = null;
    toast('That email is not on the member list. Ask an admin to add you.', 'error');
    return route();
  }
  state.me = me;
  state.profiles = await api.listProfiles();
  if (location.hash.startsWith('#/login') || !location.hash) location.replace('#/events');
  route();
}

window.addEventListener('hashchange', route);
if (api.sb) {
  api.sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') { state.me = null; route(); }
  });
}
boot();
