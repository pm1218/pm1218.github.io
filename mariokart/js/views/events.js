// Events list, new event form, and one event with its sessions.
import * as api from '../api.js';
import { ENGINE_CLASSES, EVENT_KINDS } from '../data.js';
import { AUTO_FINALIZE_HOURS, eventState, eventSummary, strengthMap, vsStrength } from '../analytics.js';
import { busy, emptyState, fmtDate, fmtDateTime, h, selectEl, spinner, toast } from '../ui.js';
import { go, page, state } from '../core.js';
import { gpTitle, summaryTable } from './widgets.js';

export async function viewEvents() {
  page('Events', spinner());
  const events = await api.listEvents();
  const form = newEventForm();
  const list = events.length
    ? h('div', { class: 'list' }, events.map((e) => {
        const confirmed = e.grand_prix.filter((g) => g.status === 'confirmed').length;
        const live = eventState(e).state === 'live';
        return h('a', { class: 'list-item', href: `#/events/${e.id}` },
          h('div', {}, h('div', { class: 'li-title' }, e.name),
            h('div', { class: 'li-sub' }, [e.kind, e.location, fmtDate(e.starts_on), `${confirmed} session${confirmed === 1 ? '' : 's'}`].filter(Boolean).join(' · '))),
          live ? h('span', { class: 'pill live' }, 'LIVE') : h('span', { class: 'pill' }, 'Final'));
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

export async function viewEvent(id) {
  page('Event', spinner());
  const [ev, gps, history] = await Promise.all([api.getEvent(id), api.listGps(id), api.confirmedGps()]);
  const strengths = strengthMap(history, state.profiles);
  const confirmed = gps.filter((g) => g.status === 'confirmed');
  const st = eventState({ ...ev, grand_prix: gps });
  const isLive = st.state === 'live';
  const canManage = ev.created_by === state.me.profile.id || state.me.isAdmin;

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
              ? `${g.engine_class} · 🏆 ${winner ? winner.label : '—'} ${winner ? `(${winner.final_total})` : ''} · ${vsStrength(g, strengths)?.label ?? ''}`
              : `${g.engine_class} · waiting for scores`)),
          h('span', { class: `pill ${g.status === 'confirmed' ? 'ok' : 'warn'}` }, g.status === 'confirmed' ? 'Confirmed' : 'Draft'));
      }))
    : emptyState('No VS sessions yet', 'Start one, race 4 times, then upload the scores.');

  const standings = confirmed.length
    ? h('section', {}, h('h2', {}, isLive ? 'Live standings' : 'Final standings'), summaryTable(eventSummary(confirmed, state.profiles)),
        h('a', { class: 'btn block', href: `#/stats/${id}` }, 'Full event analytics →'))
    : null;

  // Live until finalized by hand, or automatically after 12 h without uploads.
  const status = h('div', { class: `banner ${isLive ? 'live' : 'ok'}` });
  if (isLive) {
    status.append(h('strong', {}, '● Live event. '),
      st.autoFinalizeAt ? `Ends automatically ${fmtDateTime(st.autoFinalizeAt)} unless more scores are uploaded (${AUTO_FINALIZE_HOURS} h after the last upload).` : '');
    if (canManage) {
      const fin = h('button', { type: 'button', class: 'btn small' }, 'Finalize now');
      fin.addEventListener('click', busy(fin, async () => {
        if (!confirm(`Finalize "${ev.name}"? No more sessions can be added, and the final standings are emailed to everyone who played, plus admins.`)) return;
        await api.finalizeEvent(id); toast('Event finalized'); viewEvent(id);
      }));
      status.append(' ', fin);
    }
  } else {
    status.append(h('strong', {}, '🏁 Event over. '), `Finalized ${fmtDateTime(st.finalizedAt)}${ev.recap_sent_at ? ' · final standings emailed' : ''}.`);
    if (state.me.isAdmin) {
      const re = h('button', { type: 'button', class: 'btn small' }, 'Reopen (admin)');
      re.addEventListener('click', busy(re, async () => {
        if (!confirm('Reopen this event so more sessions can be added?')) return;
        await api.reopenEvent(id); toast('Event reopened'); viewEvent(id);
      }));
      status.append(' ', re);
    }
  }

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
    status, standings, h('h2', {}, 'VS sessions'), gpList, isLive ? form : null, del);
}
