import { COLOR_LABELS } from '../core/config.js';
import { pageAddress } from '../core/validation.js';
import { applyTheme, command, currentWindowId, element, notify, withButton } from './client.js';

const $ = id => document.getElementById(id);
const colorValues = { blue: '#5c83d8', cyan: '#4bb5bb', green: '#62b38a', purple: '#9380ca', pink: '#d78eac', yellow: '#c7ad43', orange: '#cf9557', red: '#cf727c', grey: '#9093a4' };
let windowId;
let dashboard;
let refreshTimer;
let initialSettings = true;
let editedPages = [];
let loading = null;
let currentTheme = { mode: 'dark', accent: 'blue' };
let lastSavedTheme = { ...currentTheme };
let themeSaveQueue = Promise.resolve();
let themeSavePending = 0;
let themeRevision = 0;

function route() {
  const name = ['workspace', 'collections', 'settings'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'workspace';
  for (const view of document.querySelectorAll('[data-view]')) view.hidden = view.dataset.view !== name;
  for (const link of document.querySelectorAll('[data-route]')) {
    const active = link.dataset.route === name;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  document.title = ({ workspace: '工作台', collections: '固定分组', settings: '设置' })[name] + ' · Tabloom';
  window.scrollTo({ top: 0 });
}

function empty(container, title, description) {
  const block = element('div', 'empty');
  block.append(element('strong', '', title), element('p', '', description));
  container.append(block);
}

function makeCard(group, saved) {
  const card = element('article', 'collection-card');
  card.style.setProperty('--group-color', colorValues[group.color] || colorValues.blue);
  const heading = element('div', 'card-heading');
  const title = element('div');
  title.append(element('h3', '', group.name), element('small', '', group.pages.length + ' 个页面'));
  heading.append(title);
  const preview = element('ul', 'page-preview');
  for (const page of group.pages.slice(0, 3)) {
    const item = element('li', '', page.title || new URL(page.url).hostname + new URL(page.url).pathname);
    item.title = page.url;
    preview.append(item);
  }
  if (group.pages.length > 3) preview.append(element('li', '', '还有 ' + (group.pages.length - 3) + ' 个页面'));
  const actions = element('div', 'card-actions');
  const action = (label, className, callback) => {
    const button = element('button', className, label);
    button.addEventListener('click', () => withButton(button, callback));
    actions.append(button);
  };
  if (saved) {
    action('一键打开', 'primary', () => perform('open-saved', { id: group.id }));
    action('编辑', 'quiet', () => openEditor(group));
    action('删除', 'quiet', async () => {
      if (confirm('删除固定组“' + group.name + '”的保存记录？已打开的标签页会保留。')) await perform('delete-collection', { id: group.id });
    });
  } else {
    action('固定这组', 'secondary', () => perform('save-native', { groupId: group.id }));
  }
  card.append(heading, preview, actions);
  return card;
}

function renderLibrary() {
  if (!dashboard) return;
  const query = $('search').value.trim().toLocaleLowerCase();
  const groups = dashboard.library.filter(group => [group.name, ...group.pages.map(page => page.title + ' ' + page.url)].join(' ').toLocaleLowerCase().includes(query));
  $('collection-list').replaceChildren(...groups.map(group => makeCard(group, true)));
  $('collection-count').textContent = groups.length + ' 个固定组';
  if (!groups.length) empty($('collection-list'), query ? '没有找到匹配的固定组' : '把常用页面，留给下次。', query ? '换一个关键词试试。' : '从工作台固定现有组，或手动创建你的第一组。');
}

function populateSettings(settings) {
  $('endpoint').value = settings.endpoint;
  $('model').value = settings.model;
  $('secret').value = settings.secret;
  $('guidance').value = settings.guidance;
  $('settings-automatic').checked = settings.automatic;
  $('include-query').checked = settings.includeQuery;
  $('settle-seconds').value = settings.settleSeconds;
}

function normalizeTheme(theme) {
  return {
    mode: theme?.mode === 'light' ? 'light' : 'dark',
    accent: ['blue', 'green', 'purple', 'graphite'].includes(theme?.accent) ? theme.accent : 'blue'
  };
}

function syncThemeControls() {
  $('theme-mode').value = currentTheme.mode;
  for (const button of document.querySelectorAll('[data-theme-accent]')) {
    const active = button.dataset.themeAccent === currentTheme.accent;
    button.classList.toggle('selected', active);
    button.setAttribute('aria-pressed', String(active));
  }
}

function updateTheme(patch) {
  const next = { ...currentTheme, ...patch };
  if (next.mode === currentTheme.mode && next.accent === currentTheme.accent) return;
  currentTheme = next;
  applyTheme(currentTheme);
  syncThemeControls();

  const revision = ++themeRevision;
  themeSavePending += 1;
  $('theme-save-status').textContent = '主题已即时应用，正在保存…';
  const save = themeSaveQueue.catch(() => {}).then(async () => {
    lastSavedTheme = normalizeTheme(await command('save-theme', { value: next }));
    if (revision === themeRevision) {
      $('theme-save-status').textContent = '主题已保存，可以继续调整。';
      notify('主题已应用并保存。');
    }
  }).catch(error => {
    if (revision === themeRevision) {
      currentTheme = { ...lastSavedTheme };
      applyTheme(currentTheme);
      syncThemeControls();
      $('theme-save-status').textContent = '主题保存失败，已恢复上次选择。';
      notify('主题保存失败，已恢复上次设置：' + error.message, true);
    }
  }).finally(() => { themeSavePending -= 1; });
  themeSaveQueue = save.catch(() => {});
  return save;
}

function renderUsage(usage = {}) {
  const number = new Intl.NumberFormat('zh-CN');
  const requests = usage.requests || 0;
  $('request-count').textContent = number.format(requests);
  $('token-total').textContent = usage.totalResponses ? number.format(usage.totalTokens) : requests ? '—' : '0';

  const details = [];
  if (usage.promptResponses) details.push('输入 ' + number.format(usage.promptTokens));
  if (usage.completionResponses) details.push('输出 ' + number.format(usage.completionTokens));
  if (usage.totalResponses) details.push('已返回用量 ' + number.format(usage.totalResponses) + ' 次');
  $('token-breakdown').textContent = details.join(' · ') || (requests ? '接口未返回 Token 用量' : '等待模型返回用量');
}

async function load() {
  if (loading) return loading;
  loading = (async () => {
    dashboard = await command('dashboard', { windowId });
    if (!themeSavePending) {
      currentTheme = normalizeTheme(dashboard.theme);
      lastSavedTheme = { ...currentTheme };
      applyTheme(currentTheme);
      syncThemeControls();
    }
    $('tab-count').textContent = dashboard.tabCount;
    $('pending-count').textContent = dashboard.pendingCount;
    $('library-count').textContent = dashboard.library.length;
    renderUsage(dashboard.usage);
    $('automatic').checked = dashboard.settings.automatic;
    $('model-summary').textContent = dashboard.settings.model ? '使用模型 · ' + dashboard.settings.model : '尚未连接模型 · 前往设置';
    const busy = ['analysis', 'opening', 'saving', 'organizing'].includes(dashboard.state.phase);
    $('analyze').disabled = busy;
    $('cancel').hidden = dashboard.state.phase !== 'analysis';
    $('analysis-state').textContent = '相似用途归在一组，保留手动分组和固定页面。';
    $('native-list').replaceChildren(...dashboard.groups.map(group => makeCard(group, false)));
    if (!dashboard.groups.length) empty($('native-list'), '一个清爽的开始。', '打开一些网页，连接模型后点击“分析并整理”。');
    renderLibrary();
    if (initialSettings) {
      populateSettings(dashboard.settings);
      $('newtab-enabled').checked = dashboard.appearance.newTabEnabled;
      $('search-engine').value = dashboard.appearance.searchEngine;
      initialSettings = false;
    }
    if (busy) queueRefresh();
  })().finally(() => { loading = null; });
  return loading;
}

function queueRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => load().catch(error => notify(error.message, true)), 700);
}

async function perform(action, data = {}) {
  const pending = command(action, { windowId, ...data });
  queueRefresh();
  const result = await pending;
  if (result?.message) notify(result.message);
  await load();
  return result;
}

function openEditor(group) {
  $('collection-form').reset();
  $('collection-id').value = group?.id || '';
  $('collection-name').value = group?.name || '';
  $('collection-color').value = group?.color || 'blue';
  $('collection-addresses').value = group?.pages.map(page => page.url).join('\n') || '';
  $('editor-heading').textContent = group ? '编辑固定组' : '新建固定组';
  $('editor-error').textContent = '';
  editedPages = group?.pages || [];
  $('editor').showModal();
}

window.addEventListener('hashchange', route);
$('search').addEventListener('input', renderLibrary);
$('refresh').addEventListener('click', event => withButton(event.currentTarget, load));
$('new-collection').addEventListener('click', () => openEditor());
const settingsNavButtons = [...document.querySelectorAll('[data-settings-target]')];
function activateSettingsSection(id) {
  for (const button of settingsNavButtons) {
    const active = button.dataset.settingsTarget === id;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'location'); else button.removeAttribute('aria-current');
  }
}
for (const button of settingsNavButtons) button.addEventListener('click', () => {
  document.getElementById(button.dataset.settingsTarget)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  activateSettingsSection(button.dataset.settingsTarget);
});
if ('IntersectionObserver' in window) {
  const settingsObserver = new IntersectionObserver(entries => {
    const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (visible) activateSettingsSection(visible.target.id);
  }, { root: document.querySelector('main'), rootMargin: '-18% 0px -68% 0px', threshold: [0, .1, .25, .5] });
  for (const section of document.querySelectorAll('[data-setting-section]')) settingsObserver.observe(section);
}
for (const id of ['dismiss-editor', 'cancel-editor']) $(id).addEventListener('click', () => $('editor').close());
for (const [color, label] of Object.entries(COLOR_LABELS)) $('collection-color').add(new Option(label, color));
$('collection-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    const urls = $('collection-addresses').value.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(pageAddress);
    const titles = new Map(editedPages.map(page => [page.url, page.title]));
    await perform('save-collection', { value: { id: $('collection-id').value || undefined, name: $('collection-name').value, color: $('collection-color').value, pages: urls.map(url => ({ url, title: titles.get(url) || '' })) } });
    $('editor').close();
  } catch (error) { $('editor-error').textContent = error.message; } finally { button.disabled = false; }
});
$('settings-form').addEventListener('submit', event => {
  event.preventDefault();
  withButton(event.submitter, async () => {
    const settings = await command('save-settings', { value: { endpoint: $('endpoint').value, model: $('model').value, secret: $('secret').value, guidance: $('guidance').value, automatic: $('settings-automatic').checked, includeQuery: $('include-query').checked, settleSeconds: Number($('settle-seconds').value) } });
    populateSettings(settings);
    notify('模型连接与整理偏好已保存。');
    await load();
  });
});
$('appearance-form').addEventListener('submit', event => {
  event.preventDefault();
  withButton(event.submitter, async () => {
    notify('正在保存新标签页设置…');
    const appearance = { newTabEnabled: $('newtab-enabled').checked, searchEngine: $('search-engine').value };
    await command('save-appearance', { value: appearance });
    notify('新标签页设置已保存；开关将在下次打开时生效。');
    await load();
  });
});
$('theme-mode').addEventListener('change', event => updateTheme({ mode: event.target.value }));
for (const button of document.querySelectorAll('[data-theme-accent]')) {
  button.addEventListener('click', () => updateTheme({ accent: button.dataset.themeAccent }));
}
$('reveal').addEventListener('click', () => {
  const reveal = $('secret').type === 'password';
  $('secret').type = reveal ? 'text' : 'password';
  $('reveal').textContent = reveal ? '隐藏' : '显示';
  $('reveal').setAttribute('aria-label', reveal ? '隐藏 API 密钥' : '显示 API 密钥');
});
$('analyze').addEventListener('click', event => withButton(event.currentTarget, async () => {
  if (!dashboard?.settings.endpoint || !dashboard.settings.model) { location.hash = 'settings'; notify('先配置模型接口，再开始整理。'); return; }
  notify('正在分析，请稍候…', false, { duration: 0 });
  await perform('analyze');
}));
$('cancel').addEventListener('click', event => withButton(event.currentTarget, () => perform('cancel')));
$('automatic').addEventListener('change', event => withButton(event.currentTarget, async () => {
  if (event.target.checked && (!dashboard?.settings.endpoint || !dashboard.settings.model)) { event.target.checked = false; location.hash = 'settings'; notify('请先完成模型服务配置。'); return; }
  await perform('set-automatic', { value: event.target.checked });
  $('settings-automatic').checked = dashboard.settings.automatic;
}));
$('dissolve').addEventListener('click', event => withButton(event.currentTarget, async () => {
  if (confirm('解散当前窗口全部浏览器分组，并关闭自动整理？标签页和固定组记录会保留。')) await perform('dissolve');
}));
$('close-groups').addEventListener('click', event => withButton(event.currentTarget, async () => {
  if (confirm('关闭当前窗口所有已分组的标签页？')) await perform('close-groups');
}));
chrome.storage.onChanged.addListener(queueRefresh);
route();
currentWindowId().then(id => { windowId = id; return load(); }).catch(error => notify(error.message, true));
