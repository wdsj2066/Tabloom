import { applyTheme, command, currentWindowId, element, loadTheme, notify, withButton } from './client.js';

let windowId;
let settings;
let timer;
let previousPhase;
async function refresh() {
  const data = await command('dashboard', { windowId });
  applyTheme(await loadTheme(data.theme));
  settings = data.settings;
  document.getElementById('pending').textContent = data.pendingCount;
  document.getElementById('automatic').checked = settings.automatic;
  document.getElementById('analyze').disabled = ['analysis', 'opening', 'saving', 'organizing'].includes(data.state.phase);
  const container = document.getElementById('quick-list');
  container.replaceChildren();
  for (const item of data.library.slice(0, 4)) {
    const row = element('div', 'quick-item');
    const title = element('span', '', item.name); title.title = item.name;
    const button = element('button', 'secondary', '打开');
    button.addEventListener('click', () => withButton(button, async () => {
      const result = await command('open-saved', { windowId, id: item.id });
      notify(result.message);
    }));
    row.append(title, button); container.append(row);
  }
  if (!data.library.length) container.append(element('p', 'muted', '把常用的一组页面固定在这里。'));
  if (data.state.phase === 'analysis' && previousPhase !== 'analysis') {
    notify(data.state.message || '正在分析页面主题…', false, { duration: 0 });
  } else if (previousPhase === 'analysis' && data.state.phase !== 'analysis' && data.state.message) {
    notify(data.state.message, data.state.phase === 'error');
  }
  previousPhase = data.state.phase;
}
document.getElementById('analyze').addEventListener('click', event => withButton(event.currentTarget, async () => {
  if (!settings.endpoint || !settings.model) {
    await chrome.tabs.create({ url: chrome.runtime.getURL('app.html#settings') });
    return;
  }
  notify('正在分析页面主题…', false, { duration: 0 });
  const result = await command('analyze', { windowId });
  notify(result.message);
  await refresh();
}));
document.getElementById('automatic').addEventListener('change', event => withButton(event.currentTarget, async () => {
  if (event.target.checked && (!settings.endpoint || !settings.model)) {
    event.target.checked = false;
    notify('请先在管理中心连接模型。');
    return;
  }
  const result = await command('set-automatic', { value: event.target.checked });
  notify(result.message);
}));
chrome.storage.onChanged.addListener(() => {
  clearTimeout(timer);
  timer = setTimeout(() => refresh().catch(error => notify(error.message, true)), 350);
});
currentWindowId().then(id => { windowId = id; return refresh(); }).catch(error => notify(error.message, true));
