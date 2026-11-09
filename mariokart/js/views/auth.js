// Setup notice and email-code sign in.
import * as api from '../api.js';
import { CONFIG } from '../config.js';
import { busy, clear, h, toast } from '../ui.js';
import { nav, page, setTitle, store, view } from '../core.js';

export function viewSetup() {
  nav.hidden = true;
  page('Almost there',
    h('div', { class: 'card' },
      h('p', {}, 'This app needs its free Supabase backend connected. Add your project URL and anon key to ', h('code', {}, 'mariokart/js/config.js'), ', commit, and reload.'),
      h('p', { class: 'muted' }, 'Full steps are in mariokart/README.md → Deployment.')));
}

export function viewLogin(onSignedIn) {
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
        await onSignedIn();
      }));
      box.append(form);
      setTimeout(() => input.focus(), 50);
    }
  };
  clear(view).append(h('div', { class: 'hero' }, h('div', { class: 'hero-mark', 'aria-hidden': 'true' }, '🏆'), h('h1', {}, CONFIG.APP_NAME), h('p', { class: 'muted' }, 'Mario Kart Wii VS scores for the group.')), box);
  draw();
}
