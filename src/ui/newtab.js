import { KEYS } from '../core/config.js';
import { SEARCH_ENGINES, searchAddress } from '../core/search.js';
import { applyTheme, command, currentWindowId, element, notify, withButton } from './client.js';

const colors = { blue: '#5c83d8', cyan: '#4bb5bb', green: '#62b38a', purple: '#9380ca', pink: '#d78eac', yellow: '#c7ad43', orange: '#cf9557', red: '#cf727c', grey: '#9093a4' };
let windowId;
let appearance;

function renderCollection(group) {
  const card = element('article', 'collection-card');
  card.style.setProperty('--group-color', colors[group.color] || colors.blue);
  const heading = element('div', 'card-heading');
  const name = element('div');
  name.append(element('h3', '', group.name), element('small', '', group.pages.length + ' 个页面'));
  heading.append(name);
  const list = element('ul', 'page-preview');
  for (const page of group.pages.slice(0, 3)) {
    const item = element('li', '', page.title || new URL(page.url).hostname);
    item.title = page.url;
    list.append(item);
  }
  if (group.pages.length > 3) list.append(element('li', '', '还有 ' + (group.pages.length - 3) + ' 个页面'));
  const actions = element('div', 'card-actions');
  const open = element('button', 'primary', '一键打开');
  open.addEventListener('click', () => withButton(open, async () => {
    const result = await command('open-saved', { windowId, id: group.id });
    notify(result.message);
  }));
  const manage = element('a', 'text-link', '管理');
  manage.href = 'app.html#collections';
  actions.append(open, manage);
  card.append(heading, list, actions);
  return card;
}

async function load() {
  const data = await command('start-page');
  appearance = data.appearance;
  applyTheme(data.theme);
  const container = document.getElementById('start-collections');
  container.replaceChildren(...data.library.map(renderCollection));
  if (!data.library.length) {
    const empty = element('div', 'empty');
    empty.append(element('strong', '', '把常用页面，留给下次。'), element('p', '', '到管理中心固定一组页面，它就会出现在这里。'));
    const link = element('a', 'text-link', '创建我的第一组');
    link.href = 'app.html#collections';
    empty.append(link);
    container.append(empty);
  }
  document.getElementById('saved-count').textContent = data.library.length + ' 个固定组';
  document.getElementById('provider-label').textContent = '使用 ' + SEARCH_ENGINES[appearance.searchEngine].label + ' 搜索 · 也可以直接输入网址';
  document.getElementById('start-content').hidden = false;
}

document.getElementById('web-search').addEventListener('submit', event => {
  event.preventDefault();
  try { location.assign(searchAddress(document.getElementById('web-query').value, appearance.searchEngine)); }
  catch (error) { notify(error.message, true); }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes[KEYS.library] || changes[KEYS.appearance] || changes[KEYS.theme])) load().catch(showError);
});
function showError(error) {
  const node = document.getElementById('start-error');
  node.textContent = '新标签页加载失败：' + error.message + '。请从扩展弹窗打开设置，或重新加载扩展。';
  node.hidden = false;
}
currentWindowId().then(id => { windowId = id; return load(); }).catch(showError);
