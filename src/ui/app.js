import { COLOR_LABELS, KEYS } from '../core/config.js';
import { pageAddress } from '../core/validation.js';
import { applyTheme, command, currentWindowId, element, loadTheme, notify, withButton } from './client.js';

const $ = id => document.getElementById(id);
const colorValues = { blue: '#5c83d8', cyan: '#4bb5bb', green: '#62b38a', purple: '#9380ca', pink: '#d78eac', yellow: '#c7ad43', orange: '#cf9557', red: '#cf727c', grey: '#9093a4' };
let windowId;
let dashboard;
let refreshTimer;
let initialSettings = true;
let loading = null;
let pageRowSequence = 0;
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
  $('excluded-domains').value = (Array.isArray(settings.excludedDomains) ? settings.excludedDomains : []).join('\n');
  $('settle-seconds').value = settings.settleSeconds;
}

function populatePricing(pricing = {}) {
  $('pricing-currency').value = pricing.currency || '¥';
  $('pricing-input').value = pricing.inputPerMillion ?? '';
  $('pricing-output').value = pricing.outputPerMillion ?? '';
}

function normalizeTheme(theme) {
  return {
    mode: theme?.mode === 'light' ? 'light' : 'dark',
    accent: ['blue', 'green', 'purple', 'graphite'].includes(theme?.accent) ? theme.accent : 'blue'
  };
}

function syncThemeControls() {
  for (const button of document.querySelectorAll('[data-theme-mode]')) {
    const active = button.dataset.themeMode === currentTheme.mode;
    button.classList.toggle('selected', active);
    button.setAttribute('aria-pressed', String(active));
  }
  for (const button of document.querySelectorAll('[data-theme-accent]')) {
    const active = button.dataset.themeAccent === currentTheme.accent;
    button.classList.toggle('selected', active);
    button.setAttribute('aria-pressed', String(active));
  }
}

function setSearchEngine(value) {
  $('search-engine').value = value;
  for (const button of document.querySelectorAll('[data-search-engine]')) {
    const active = button.dataset.searchEngine === value;
    button.classList.toggle('selected', active);
    button.setAttribute('aria-pressed', String(active));
  }
}

function setCollectionColor(value) {
  $('collection-color').value = value;
  for (const button of document.querySelectorAll('[data-collection-color]')) {
    const active = button.dataset.collectionColor === value;
    button.classList.toggle('selected', active);
    button.setAttribute('aria-pressed', String(active));
  }
}

function makePageEditorRow(page = {}) {
  const row = element('div', 'page-editor-row');
  const sequence = ++pageRowSequence;
  const titleInput = element('input');
  titleInput.id = 'page-title-' + sequence;
  titleInput.type = 'text';
  titleInput.maxLength = 200;
  titleInput.placeholder = '留空时显示网站名称';
  titleInput.value = page.title || '';
  titleInput.dataset.pageTitle = '';
  const titleField = element('label', 'page-editor-field');
  titleField.htmlFor = titleInput.id;
  titleField.append(element('span', '', '页面标题（可选）'), titleInput);

  const urlInput = element('input');
  urlInput.id = 'page-url-' + sequence;
  urlInput.type = 'url';
  urlInput.required = true;
  urlInput.placeholder = 'https://example.com';
  urlInput.value = page.url || '';
  urlInput.dataset.pageUrl = '';
  const urlField = element('label', 'page-editor-field page-editor-url');
  urlField.htmlFor = urlInput.id;
  const duplicateNote = element('small', 'page-duplicate-note', '与前面的页面重复');
  duplicateNote.hidden = true;
  urlField.append(element('span', '', '页面网址'), urlInput, duplicateNote);

  const actions = element('div', 'page-editor-actions');
  const move = (label, delta, ariaLabel) => {
    const button = element('button', 'quiet page-order-button', label);
    button.type = 'button';
    button.setAttribute('aria-label', ariaLabel);
    button.addEventListener('click', () => {
      const sibling = delta < 0 ? row.previousElementSibling : row.nextElementSibling;
      if (!sibling) return;
      if (delta < 0) row.parentElement.insertBefore(row, sibling);
      else row.parentElement.insertBefore(sibling, row);
      updatePageEditorState();
    });
    actions.append(button);
    return button;
  };
  move('上移', -1, '上移此页面');
  move('下移', 1, '下移此页面');
  const remove = element('button', 'quiet page-remove-button', '删除');
  remove.type = 'button';
  remove.setAttribute('aria-label', '删除此页面');
  remove.addEventListener('click', () => {
    row.remove();
    updatePageEditorState();
  });
  actions.append(remove);
  row.append(titleField, urlField, actions);
  return row;
}

function updatePageEditorState() {
  const rows = [...$('page-editor-list').children];
  const seen = new Set();
  let duplicateCount = 0;
  $('page-count').textContent = rows.length + ' / 300';
  $('add-page').disabled = rows.length >= 300;
  $('page-editor-empty').hidden = rows.length > 0;
  rows.forEach((row, index) => {
    row.querySelector('.page-order-button[aria-label="上移此页面"]').disabled = index === 0;
    row.querySelector('.page-order-button[aria-label="下移此页面"]').disabled = index === rows.length - 1;
    const urlInput = row.querySelector('[data-page-url]');
    const warning = row.querySelector('.page-duplicate-note');
    let duplicate = false;
    try {
      const address = pageAddress(urlInput.value.trim());
      duplicate = seen.has(address);
      seen.add(address);
    } catch {}
    row.classList.toggle('is-duplicate', duplicate);
    warning.hidden = !duplicate;
    if (duplicate) duplicateCount += 1;
  });
  $('remove-duplicate-pages').disabled = duplicateCount === 0;
}

function renderPageEditor(pages) {
  $('page-editor-list').replaceChildren(...pages.map(makePageEditorRow));
  updatePageEditorState();
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
    await chrome.storage.local.set({ [KEYS.theme]: next });
    lastSavedTheme = normalizeTheme(next);
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

function renderUsage(usage = {}, pricing = {}) {
  const number = new Intl.NumberFormat('zh-CN');
  const requests = usage.requests || 0;
  $('request-count').textContent = number.format(requests);
  const partialTotals = usage.usageResponses > usage.totalResponses;
  $('token-total').textContent = usage.totalResponses ? (partialTotals ? '≥ ' : '') + number.format(usage.totalTokens) : requests ? '—' : '0';

  const details = [];
  if (usage.promptResponses) details.push('输入 ' + number.format(usage.promptTokens));
  if (usage.completionResponses) details.push('输出 ' + number.format(usage.completionTokens));
  if (usage.totalResponses) details.push('已返回用量 ' + number.format(usage.totalResponses) + ' 次');
  if (partialTotals) details.push('部分响应未提供总量，显示已知合计');
  $('token-breakdown').textContent = details.join(' · ') || (requests ? '接口未返回 Token 用量' : '等待模型返回用量');
  const hasRates = pricing.inputPerMillion !== null && pricing.inputPerMillion !== undefined && pricing.outputPerMillion !== null && pricing.outputPerMillion !== undefined;
  const hasSplitUsage = usage.promptResponses || usage.completionResponses;
  if (!hasRates) $('usage-estimate').textContent = '尚未设置完整单价，费用估算已关闭。';
  else if (!hasSplitUsage) $('usage-estimate').textContent = '暂无可用于估算的输入、输出 Token 用量。';
  else {
    const amount = (usage.promptTokens * pricing.inputPerMillion + usage.completionTokens * pricing.outputPerMillion) / 1_000_000;
    const formatted = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(amount);
    $('usage-estimate').textContent = '累计估算：' + pricing.currency + formatted + ' · 仅按接口返回的 Token 计算。';
  }

  const trend = $('usage-trend');
  const daily = new Map((usage.daily || []).map(item => [item.date, item]));
  const days = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - offset);
    const key = date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
    days.push(daily.get(key) || { date: key, requests: 0, totalTokens: 0, totalResponses: 0 });
  }
  if (!days.some(item => item.requests || item.totalTokens)) {
    trend.replaceChildren(element('p', 'usage-trend-empty', '近七天暂无模型请求。'));
    return;
  }
  const maxRequests = Math.max(1, ...days.map(item => item.requests));
  const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'short' });
  trend.replaceChildren(...days.map(item => {
    const date = new Date(item.date + 'T12:00:00');
    const card = element('div', 'usage-day');
    const label = element('span', 'usage-day-label', weekday.format(date));
    const barTrack = element('div', 'usage-day-track');
    const bar = element('span', 'usage-day-bar');
    bar.style.height = item.requests ? Math.max(8, item.requests / maxRequests * 100) + '%' : '2px';
    barTrack.append(bar);
    const requestValue = element('strong', '', number.format(item.requests));
    const tokenValue = element('small', '', item.totalResponses ? number.format(item.totalTokens) + ' Token' : '— Token');
    const dateLabel = element('span', 'usage-day-date', item.date.slice(5).replace('-', '/'));
    card.append(label, barTrack, requestValue, tokenValue, dateLabel);
    card.title = item.date + ' · ' + number.format(item.requests) + ' 次请求 · ' + (item.totalResponses ? number.format(item.totalTokens) + ' Token' : '未返回 Token 用量');
    return card;
  }));
}

function renderActivity(items = [], undo, busy = false) {
  const list = $('activity-list');
  const recent = items.slice(0, 8);
  $('activity-empty').hidden = recent.length > 0;
  list.hidden = recent.length === 0;
  list.replaceChildren(...recent.map(item => {
    const row = element('li', 'activity-item');
    const heading = element('div', 'activity-item-heading');
    const title = element('strong', '', item.type === 'undo' ? '撤销整理' : '整理');
    const time = element('time', '', new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(item.time));
    time.dateTime = new Date(item.time).toISOString();
    heading.append(title, time);
    const summary = element('p', '', item.message || ((item.pages || 0) + ' 个页面 · ' + (item.groups || 0) + ' 个分组'));
    row.append(heading, summary);
    return row;
  }));
  const canUndo = !!undo?.pages?.length;
  $('undo-analysis').hidden = !canUndo;
  $('undo-analysis').disabled = busy;
  if (canUndo) $('undo-analysis').textContent = '撤销上次整理（' + undo.pages.length + '）';
}

async function load() {
  if (loading) return loading;
  loading = (async () => {
    dashboard = await command('dashboard', { windowId });
    const savedTheme = await loadTheme(dashboard.theme);
    if (!themeSavePending) {
      currentTheme = normalizeTheme(savedTheme);
      lastSavedTheme = { ...currentTheme };
      applyTheme(currentTheme);
      syncThemeControls();
    }
    $('tab-count').textContent = dashboard.tabCount;
    $('pending-count').textContent = dashboard.pendingCount;
    $('library-count').textContent = dashboard.library.length;
    renderUsage(dashboard.usage, dashboard.pricing);
    $('automatic').checked = dashboard.settings.automatic;
    $('model-summary').textContent = dashboard.settings.model ? '使用模型 · ' + dashboard.settings.model : '尚未连接模型 · 前往设置';
    const busy = ['analysis', 'opening', 'saving', 'organizing'].includes(dashboard.state.phase);
    $('analyze').disabled = busy;
    $('cancel').hidden = dashboard.state.phase !== 'analysis';
    $('analysis-state').textContent = '相似用途归在一组，保留手动分组和固定页面。';
    renderActivity(dashboard.activity || [], dashboard.undo, busy);
    $('native-list').replaceChildren(...dashboard.groups.map(group => makeCard(group, false)));
    if (!dashboard.groups.length) empty($('native-list'), '一个清爽的开始。', '打开一些网页，连接模型后点击“开始整理”。');
    renderLibrary();
    if (initialSettings) {
      populateSettings(dashboard.settings);
      populatePricing(dashboard.pricing);
      $('newtab-enabled').checked = dashboard.appearance.newTabEnabled;
      setSearchEngine(dashboard.appearance.searchEngine);
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
  setCollectionColor(group?.color || 'blue');
  renderPageEditor(group?.pages?.length ? group.pages : [{}]);
  $('editor-heading').textContent = group ? '编辑固定组' : '新建固定组';
  $('editor-error').textContent = '';
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
for (const [color, label] of Object.entries(COLOR_LABELS)) {
  const button = element('button', 'choice-chip collection-color-choice', label);
  const dot = element('span', 'collection-color-dot');
  button.type = 'button';
  button.dataset.collectionColor = color;
  button.setAttribute('aria-pressed', 'false');
  dot.style.setProperty('--group-color', colorValues[color] || colorValues.blue);
  button.prepend(dot);
  button.addEventListener('click', () => setCollectionColor(color));
  $('collection-colors').append(button);
}
$('collection-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter || $('collection-form').querySelector('button[type="submit"]');
  if (button) button.disabled = true;
  try {
    const pages = [...$('page-editor-list').querySelectorAll('.page-editor-row')].map(row => ({
      url: pageAddress(row.querySelector('[data-page-url]').value.trim()),
      title: row.querySelector('[data-page-title]').value.trim()
    }));
    if (!pages.length) throw new Error('固定组至少需要一个页面。');
    if (pages.length > 300) throw new Error('每个固定组最多保存 300 个页面。');
    await perform('save-collection', { value: { id: $('collection-id').value || undefined, name: $('collection-name').value, color: $('collection-color').value, pages } });
    $('editor').close();
  } catch (error) { $('editor-error').textContent = error.message; } finally { if (button) button.disabled = false; }
});
$('page-editor-list').addEventListener('input', () => { $('editor-error').textContent = ''; updatePageEditorState(); });
$('add-page').addEventListener('click', () => {
  const row = makePageEditorRow();
  $('page-editor-list').append(row);
  $('editor-error').textContent = '';
  updatePageEditorState();
  row.querySelector('[data-page-title]').focus();
});
$('remove-duplicate-pages').addEventListener('click', () => {
  const seen = new Set();
  for (const row of [...$('page-editor-list').children]) {
    const input = row.querySelector('[data-page-url]');
    try {
      const address = pageAddress(input.value.trim());
      if (seen.has(address)) row.remove();
      else seen.add(address);
    } catch {}
  }
  $('editor-error').textContent = '';
  updatePageEditorState();
});
$('settings-form').addEventListener('submit', event => {
  event.preventDefault();
  withButton(event.submitter || $('settings-form').querySelector('button[type="submit"]'), async () => {
    const settings = await command('save-settings', { value: { endpoint: $('endpoint').value, model: $('model').value, secret: $('secret').value, guidance: $('guidance').value, automatic: $('settings-automatic').checked, includeQuery: $('include-query').checked, excludedDomains: $('excluded-domains').value.split(/\r?\n/).map(domain => domain.trim()).filter(Boolean), settleSeconds: Number($('settle-seconds').value) } });
    populateSettings(settings);
    notify('模型连接与整理偏好已保存。');
    await load();
  });
});
$('pricing-form').addEventListener('submit', event => {
  event.preventDefault();
  withButton(event.submitter || $('pricing-form').querySelector('button[type="submit"]'), async () => {
    const pricing = await command('save-pricing', { value: { currency: $('pricing-currency').value, inputPerMillion: $('pricing-input').value, outputPerMillion: $('pricing-output').value } });
    dashboard.pricing = pricing;
    populatePricing(pricing);
    renderUsage(dashboard.usage, pricing);
    notify(pricing.inputPerMillion === null ? '费用估算已关闭。' : '估算单价已保存在本机。');
  });
});
$('appearance-form').addEventListener('submit', event => {
  event.preventDefault();
  withButton(event.submitter || $('appearance-form').querySelector('button[type="submit"]'), async () => {
    notify('正在保存新标签页设置…');
    const appearance = { newTabEnabled: $('newtab-enabled').checked, searchEngine: $('search-engine').value };
    await command('save-appearance', { value: appearance });
    notify('新标签页设置已保存；开关将在下次打开时生效。');
    await load();
  });
});
for (const button of document.querySelectorAll('[data-theme-mode]')) {
  button.addEventListener('click', () => updateTheme({ mode: button.dataset.themeMode }));
}
for (const button of document.querySelectorAll('[data-theme-accent]')) {
  button.addEventListener('click', () => updateTheme({ accent: button.dataset.themeAccent }));
}
for (const button of document.querySelectorAll('[data-search-engine]')) {
  button.addEventListener('click', () => setSearchEngine(button.dataset.searchEngine));
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
$('undo-analysis').addEventListener('click', event => withButton(event.currentTarget, () => perform('undo')));
$('import-collections').addEventListener('click', () => $('collection-import-file').click());
$('collection-import-file').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    if (file.size > 5 * 1024 * 1024) throw new Error('导入文件不能超过 5 MB。');
    const backup = JSON.parse(await file.text());
    if (backup?.format !== 'tabloom-collections' || backup.version !== 1 || !Array.isArray(backup.collections)) throw new Error('这不是受支持的 Tabloom 固定组备份文件。');
    if (!backup.collections.length) throw new Error('备份文件里没有固定组。');
    if (backup.collections.length > 500) throw new Error('一次最多导入 500 个固定组。');
    if (!confirm('将作为新记录导入 ' + backup.collections.length + ' 个固定组，不会覆盖现有内容。继续吗？')) return;
    await perform('import-collections', { collections: backup.collections });
  } catch (error) { notify(error.message, true); }
  finally { event.target.value = ''; }
});
$('export-collections').addEventListener('click', () => {
  const collections = (dashboard?.library || []).map(({ name, color, pages }) => ({ name, color, pages: pages.map(({ url, title }) => ({ url, title })) }));
  if (!collections.length) { notify('当前没有可导出的固定组。', true); return; }
  const backup = { format: 'tabloom-collections', version: 1, exportedAt: new Date().toISOString(), collections };
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
  const link = element('a');
  link.href = url;
  link.download = 'tabloom-fixed-groups-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify('固定组备份已导出。');
});
$('close-groups').addEventListener('click', event => withButton(event.currentTarget, async () => {
  if (confirm('关闭当前窗口所有已分组的标签页？')) await perform('close-groups');
}));
chrome.storage.onChanged.addListener(queueRefresh);
route();
currentWindowId().then(id => { windowId = id; return load(); }).catch(error => notify(error.message, true));
