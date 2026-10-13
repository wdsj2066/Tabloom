import { KEYS } from '../core/config.js';

const AMBIENT_CYCLE_SECONDS = 52;
const AMBIENT_SECONDARY_CYCLE_SECONDS = 67;
if (typeof document !== 'undefined' && document.body) {
  const firstX = 28 + Math.random() * 14;
  const secondX = 58 + Math.random() * 14;
  const firstY = 28 + Math.random() * 44;
  const secondY = Math.max(20, Math.min(80, firstY + (Math.random() - 0.5) * 16));
  document.body.style.setProperty('--ambient-flow-a-x', firstX + 'vw');
  document.body.style.setProperty('--ambient-flow-a-y', firstY + 'vh');
  document.body.style.setProperty('--ambient-flow-b-x', secondX + 'vw');
  document.body.style.setProperty('--ambient-flow-b-y', secondY + 'vh');
  document.body.style.setProperty('--ambient-flow-a-delay', (-Math.random() * AMBIENT_CYCLE_SECONDS) + 's');
  document.body.style.setProperty('--ambient-flow-b-delay', (-Math.random() * AMBIENT_SECONDARY_CYCLE_SECONDS) + 's');
}

export async function currentWindowId() { return (await chrome.windows.getCurrent()).id; }
export async function command(action, data = {}) {
  const response = await chrome.runtime.sendMessage({ channel: 'tabloom', action, ...data });
  if (!response?.success) throw new Error(response?.error || '扩展后台没有响应，请重新加载扩展。');
  return response.value;
}
export function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
export async function loadTheme(fallback) {
  const stored = (await chrome.storage.local.get(KEYS.theme))[KEYS.theme];
  return stored ?? fallback;
}
export function applyTheme(theme = 'dark') {
  const mode = typeof theme === 'string' ? theme : theme?.mode;
  const selected = mode === 'light' ? 'light' : 'dark';
  const accents = ['blue', 'green', 'purple', 'graphite'];
  const accent = accents.includes(theme?.accent) ? theme.accent : 'blue';
  document.body.classList.toggle('theme-light', selected === 'light');
  document.body.classList.toggle('theme-dark', selected === 'dark');
  for (const name of accents) document.body.classList.toggle('accent-' + name, name === accent);
}
let notificationTimer;
export function notify(text, error = false, { duration = 3200 } = {}) {
  const node = document.getElementById('feedback');
  if (!node) return;
  clearTimeout(notificationTimer);
  node.textContent = text;
  node.classList.toggle('error', error);
  node.classList.add('visible');
  if (duration > 0) {
    notificationTimer = setTimeout(() => node.classList.remove('visible'), duration);
  }
}
export async function withButton(button, action) {
  button.disabled = true;
  try { return await action(); } catch (error) { notify(error.message, true); } finally { button.disabled = false; }
}
