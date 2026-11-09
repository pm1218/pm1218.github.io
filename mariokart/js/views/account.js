// Your profile, and the admin member list.
import * as api from '../api.js';
import { CHARACTERS } from '../data.js';
import { busy, fmtDate, h, selectEl, spinner, toast } from '../ui.js';
import { go, page, state } from '../core.js';

export function viewMe() {
  const p = state.me.profile;
  const name = h('input', { id: 'me-name', value: p.display_name, maxlength: '40', required: true });
  const fav = selectEl([{ value: '', label: 'Choose…' }, ...CHARACTERS], p.favorite_character || '', { id: 'me-fav' });
  // Photos show character names, so each player should pick a different one.
  const clash = h('p', { class: 'warn-text small', 'aria-live': 'polite' });
  const showClash = () => {
    const others = state.profiles.filter((o) => o.id !== p.id && o.favorite_character && o.favorite_character === fav.value).map((o) => o.display_name);
    clash.textContent = others.length ? `${others.join(' and ')} also race${others.length === 1 ? 's' : ''} as ${fav.value}, so photos can't tell you apart — you'll be asked to choose.` : '';
  };
  fav.addEventListener('change', showClash); showClash();
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'Save');
  const form = h('form', { class: 'card' },
    h('label', { for: 'me-name' }, 'Display name'), name,
    h('label', { for: 'me-fav' }, 'Your character'), fav,
    h('p', { class: 'muted small' }, 'The character you race as. Score screens show character names, so this is how photos recognise you.'),
    clash, btn);
  form.addEventListener('submit', busy(btn, async () => {
    state.me.profile = await api.updateProfile(p.id, { display_name: name.value.trim(), favorite_character: fav.value || null });
    state.profiles = await api.listProfiles();
    toast('Saved');
  }));
  const out = h('button', { class: 'btn block' }, 'Sign out');
  out.addEventListener('click', busy(out, async () => { await api.signOut(); state.me = null; go('#/login'); }));
  page('Me', h('p', { class: 'muted' }, state.me.session.user.email), form, out);
}

// ==================================================================== admin
export async function viewAdmin() {
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
