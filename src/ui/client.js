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
export function notify(text, error = false) {
  const node = document.getElementById('feedback');
  node.textContent = text;
  node.classList.toggle('error', error);
}
export async function withButton(button, action) {
  button.disabled = true;
  try { return await action(); } catch (error) { notify(error.message, true); } finally { button.disabled = false; }
}
