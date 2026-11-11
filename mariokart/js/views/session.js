// One VS session: confirmed results, or the score entry screen (manual or photo).
import * as api from '../api.js';
import { ALL_TRACKS, CHARACTERS, MAX_GP_TOTAL, MAX_PLAYERS, RACES_PER_GP, ordinal, pointsFor } from '../data.js';
import { addExtraAsPlayer, completedRaceCount, computeStandings, draftFromScreens, emptyDraft, isRaceComplete, makeParticipant, toPayload, validateDraft } from '../scoring.js';
import { suggestIdentities } from '../identity.js';
import { busy, charBadge, clear, fmtDateTime, h, selectEl, spinner, table, toast } from '../ui.js';
import { go, page, profileName, state, store } from '../core.js';
import { cloneCanvas, gpTitle, medal } from './widgets.js';

export async function viewGp(id) {
  page('VS session', spinner());
  const gp = await api.getGp(id);
  if (gp.status !== 'confirmed') return viewGpEntry(gp);

  const title = gpTitle(gp);
  const parts = gp.participants;
  const results = table(['', 'Player', 'Char', 'Pts'], parts.map((p) => [
    medal(p.final_place), h('span', {}, p.profile_id ? h('strong', {}, p.label) : p.label, p.is_cpu ? h('span', { class: 'tag' }, 'CPU') : null, !p.profile_id && !p.is_cpu ? h('span', { class: 'tag' }, 'guest') : null),
    charBadge(p.character), h('strong', {}, p.final_total)]), { stickyFirst: false, cls: 'results' });

  let raceTable = null;
  if (gp.entry_mode !== 'races' && gp.races.some((r) => r.track)) {
    raceTable = h('section', {}, h('h2', {}, 'Tracks played'), h('ol', { class: 'track-list' }, gp.races.map((r) => h('li', {}, r.track))));
  }
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
  actions.append(h('p', { class: 'muted small' },
    `Confirmed ${fmtDateTime(gp.confirmed_at)} by ${profileName(gp.confirmed_by)} · `,
    gp.summary_sent_at ? `summary emailed ${fmtDateTime(gp.summary_sent_at)}` : 'summary email queued (usually arrives within a couple of minutes)'));
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
        // The character follows the player when it was blank or just the
        // previous player's usual character; one picked by hand stays.
        const prev = members.find((x) => x.id === p.profile_id);
        const autoChar = !p.character || (prev && p.character === prev.favorite_character);
        if (v === '__guest') {
          p.profile_id = null; p.is_cpu = false;
          if (!p.label || members.some((m) => m.display_name === p.label)) p.label = 'Guest';
        } else {
          const m = members.find((x) => x.id === v);
          p.profile_id = v; p.is_cpu = false; p.label = m.display_name;
          if (autoChar) p.character = m.favorite_character || null;
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

  // ---- tracks played (optional in final-totals mode)
  function tracksEditor() {
    return h('section', {},
      h('h2', {}, 'Tracks played'),
      h('p', { class: 'muted small' }, 'Optional — adds this session to the track stats.'),
      h('div', { class: 'card tight' }, draft.races.map((r, i) => {
        const sel = selectEl([{ value: '', label: '—' }, ...ALL_TRACKS], r.track || '', { 'aria-label': `Race ${i + 1} track` });
        sel.addEventListener('change', () => { r.track = sel.value; persist(); });
        return h('label', { class: 'total-row' }, h('span', {}, `Race ${i + 1}`), sel);
      })));
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
      const vision = await import('../vision.js');
      progress.hidden = false;
      const setP = (frac, label) => { progress.querySelector('.bar').style.width = `${Math.round(frac * 100)}%`; progress.querySelector('.progress-label').textContent = label; };
      const templates = await api.loadTemplates().catch(() => []);
      const screens = [];
      photo.colorCanvases = [];
      for (const [n, i] of slots.entries()) {
        const res = await vision.analyzePhoto(photo.files[i], {
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
  const confirmBtn = h('button', { type: 'button', class: 'btn primary block big' }, 'Confirm & email the players');
  confirmBtn.addEventListener('click', busy(confirmBtn, async () => {
    const payload = toPayload(draft);
    if (!confirm(`Confirm VS ${gp.seq} (${draft.mode === 'races' ? '4 races' : 'final totals'}) and email the summary to the players and admins?`)) return;
    if (photo.analysis) {
      confirmBtn.textContent = 'Uploading photos…';
      const vision = await import('../vision.js');
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
    toast('Confirmed 🎉 The summary email is on its way.');
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
      tab === 'total' ? tracksEditor() : null,
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
