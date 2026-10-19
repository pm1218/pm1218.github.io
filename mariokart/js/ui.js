// Tiny DOM helpers — no framework, no build step.
import { CHARACTER_COLORS } from './data.js';

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const clear = (el) => { while (el.firstChild) el.firstChild.remove(); return el; };

export function selectEl(options, value, attrs = {}) {
  return h('select', attrs, options.map((o) => {
    const opt = typeof o === 'object' ? o : { value: o, label: o };
    return h('option', { value: opt.value ?? '', selected: String(opt.value ?? '') === String(value ?? ''), disabled: opt.disabled }, opt.label);
  }));
}

export function toast(message, kind = 'info') {
  const host = document.getElementById('toasts');
  const t = h('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  host.append(t);
  setTimeout(() => t.classList.add('out'), kind === 'error' ? 6000 : 3500);
  setTimeout(() => t.remove(), kind === 'error' ? 6600 : 4100);
}

export function charBadge(name) {
  if (!name) return h('span', { class: 'char-badge muted' }, '—');
  const initials = name.replace(/[^A-Za-z ]/g, '').split(' ').map((w) => w[0]).join('').slice(0, 2);
  return h('span', { class: 'char-badge', title: name },
    h('span', { class: 'char-dot', style: { background: CHARACTER_COLORS[name] || '#888' } }, initials),
    h('span', { class: 'char-name' }, name));
}

export const fmtDate = (d) => (d ? new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '');
export const fmtDateTime = (d) => (d ? new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

export const spinner = (label = 'Loading…') => h('div', { class: 'loading', role: 'status' }, h('span', { class: 'spin' }), label);

export function emptyState(title, body, action) {
  return h('div', { class: 'empty' }, h('p', { class: 'empty-title' }, title), body && h('p', {}, body), action);
}

// Wrap an async click handler: disables the button and reports errors.
export function busy(btn, fn) {
  return async (ev) => {
    ev?.preventDefault?.();
    if (btn.disabled) return;
    const label = btn.textContent;
    btn.disabled = true;
    btn.classList.add('is-busy');
    try {
      await fn(ev);
    } catch (e) {
      console.error(e);
      toast(e.message || String(e), 'error');
    } finally {
      btn.disabled = false;
      btn.classList.remove('is-busy');
      btn.textContent = label;
    }
  };
}

export function table(headers, rows, { stickyFirst = true, cls = '' } = {}) {
  return h('div', { class: `table-wrap ${cls}` },
    h('table', { class: stickyFirst ? 'sticky-first' : '' },
      h('thead', {}, h('tr', {}, headers.map((x) => h('th', { scope: 'col' }, x)))),
      h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c, i) => (i === 0 && stickyFirst ? h('th', { scope: 'row' }, c) : h('td', {}, c))))))));
}
