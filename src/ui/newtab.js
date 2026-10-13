import { KEYS } from '../core/config.js';
import { SEARCH_ENGINES, searchAddress } from '../core/search.js';
import { applyTheme, command, currentWindowId, element, loadTheme, notify, withButton } from './client.js';

const colors = { blue: '#5c83d8', cyan: '#4bb5bb', green: '#62b38a', purple: '#9380ca', pink: '#d78eac', yellow: '#c7ad43', orange: '#cf9557', red: '#cf727c', grey: '#9093a4' };
const BOOKMARK_GROUPS_PER_PAGE = 3;
const BOOKMARK_TAGS_PER_CARD = 3;
let windowId;
let appearance;
let bookmarkGroups = [];
let bookmarkPage = 0;
const bookmarkPreviewData = new WeakMap();
const bookmarkPreviewObserver = new ResizeObserver(entries => {
  for (const { target } of entries) fitBookmarkPreview(target);
});

function fitBookmarkPreview(list) {
  const { group, items, moreItem, more, count } = bookmarkPreviewData.get(list);
  const available = list.clientWidth;
  if (!available) return;
  list.classList.add('measuring');
  items.forEach(item => { item.hidden = false; });
  moreItem.hidden = false;
  const widths = items.map(item => item.getBoundingClientRect().width);
  const gap = parseFloat(getComputedStyle(list).columnGap) || 0;
  let visible = items.length;
  for (; visible > 0; visible--) {
    const remaining = count - visible;
    more.textContent = '+' + remaining;
    const moreWidth = remaining > 0 ? moreItem.getBoundingClientRect().width : 0;
    const needed = widths.slice(0, visible).reduce((sum, width) => sum + width, 0)
      + moreWidth + gap * (visible - 1 + (remaining > 0 ? 1 : 0));
    if (needed <= available || visible === 1) break;
  }
  const remaining = count - visible;
  items.forEach((item, index) => { item.hidden = index >= visible; });
  more.textContent = '+' + remaining;
  more.setAttribute('aria-label', '展开' + group.name + '收藏夹中的其余 ' + remaining + ' 个网页');
  moreItem.hidden = remaining <= 0;
  list.classList.remove('measuring');
}

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
  const open = element('button', 'primary collection-action', '一键打开');
  open.addEventListener('click', () => withButton(open, async () => {
    const result = await command('open-saved', { windowId, id: group.id });
    notify(result.message);
  }));
  const manage = element('a', 'text-link collection-action collection-manage-link', '管理');
  manage.href = 'app.html#collections';
  manage.setAttribute('aria-label', '管理固定组');
  actions.append(open, manage);
  card.append(heading, list, actions);
  return card;
}

function renderBookmarkTag(page) {
  const url = new URL(page.url);
  const hostname = url.hostname.replace(/^www\./i, '');
  const title = page.title || hostname;
  const item = element('li');
  const link = element('a', 'bookmark-tag', title);
  link.href = url.href;
  link.title = title + ' · ' + url.href;
  link.setAttribute('aria-label', title + ' · ' + hostname);
  item.append(link);
  return item;
}

function openBookmarkDialog(group) {
  const count = group.pageCount ?? group.pages.length;
  document.getElementById('bookmark-dialog-title').textContent = group.name;
  document.getElementById('bookmark-dialog-caption').textContent = [group.path, count + ' 个网页'].filter(Boolean).join(' · ');
  document.getElementById('bookmark-dialog-links').replaceChildren(...group.pages.map(renderBookmarkTag));
  document.getElementById('bookmark-dialog').showModal();
}

function renderBookmarkGroup(group) {
  const card = element('article', 'collection-card bookmark-group-card');
  const heading = element('div', 'card-heading');
  const name = element('div');
  const count = group.pageCount ?? group.pages.length;
  name.append(element('h3', '', group.name), element('small', '', [group.path, count + ' 个网页'].filter(Boolean).join(' · ')));
  heading.append(name);
  const list = element('ul', 'bookmark-page-tags');
  const items = group.pages.slice(0, BOOKMARK_TAGS_PER_CARD).map(renderBookmarkTag);
  const more = element('button', 'bookmark-tag bookmark-more');
  more.type = 'button';
  more.title = '查看“' + group.name + '”中的全部网页';
  more.addEventListener('click', () => openBookmarkDialog(group));
  const moreItem = element('li');
  moreItem.append(more);
  list.append(...items, moreItem);
  bookmarkPreviewData.set(list, { group, items, moreItem, more, count });
  bookmarkPreviewObserver.observe(list);
  card.append(heading, list);
  return card;
}

function renderBookmarkGroups() {
  bookmarkPreviewObserver.disconnect();
  const start = bookmarkPage * BOOKMARK_GROUPS_PER_PAGE;
  const visibleGroups = bookmarkGroups.slice(start, start + BOOKMARK_GROUPS_PER_PAGE);
  document.getElementById('bookmark-collections').replaceChildren(...visibleGroups.map(renderBookmarkGroup));
  document.getElementById('bookmark-count').textContent = bookmarkGroups.length + ' 个收藏夹';

  const pageCount = Math.ceil(bookmarkGroups.length / BOOKMARK_GROUPS_PER_PAGE);
  const pager = document.getElementById('bookmark-pager');
  pager.hidden = pageCount <= 1;
  document.getElementById('bookmark-previous').disabled = bookmarkPage === 0;
  document.getElementById('bookmark-next').disabled = bookmarkPage >= pageCount - 1;
  document.getElementById('bookmark-page-indicator').textContent = bookmarkGroups.length
    ? (start + 1) + '–' + Math.min(start + BOOKMARK_GROUPS_PER_PAGE, bookmarkGroups.length) + ' / ' + bookmarkGroups.length
    : '';
}

async function load() {
  const data = await command('start-page');
  appearance = data.appearance;
  applyTheme(await loadTheme(data.theme));
  const bookmarkSection = document.getElementById('bookmark-section');
  bookmarkGroups = data.bookmarks || [];
  bookmarkPage = Math.min(bookmarkPage, Math.max(0, Math.ceil(bookmarkGroups.length / BOOKMARK_GROUPS_PER_PAGE) - 1));
  renderBookmarkGroups();
  bookmarkSection.hidden = !bookmarkGroups.length;
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

document.getElementById('bookmark-previous').addEventListener('click', () => {
  if (bookmarkPage === 0) return;
  bookmarkPage -= 1;
  renderBookmarkGroups();
});
document.getElementById('bookmark-next').addEventListener('click', () => {
  if (bookmarkPage >= Math.ceil(bookmarkGroups.length / BOOKMARK_GROUPS_PER_PAGE) - 1) return;
  bookmarkPage += 1;
  renderBookmarkGroups();
});
document.getElementById('bookmark-dialog-close').addEventListener('click', () => {
  document.getElementById('bookmark-dialog').close();
});
document.getElementById('bookmark-dialog').addEventListener('click', event => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});

document.getElementById('web-search').addEventListener('submit', event => {
  event.preventDefault();
  try { location.assign(searchAddress(document.getElementById('web-query').value, appearance.searchEngine)); }
  catch (error) { notify(error.message, true); }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes[KEYS.library] || changes[KEYS.appearance] || changes[KEYS.theme])) load().catch(showError);
});
let bookmarkRefreshTimer;
function refreshBookmarks() {
  clearTimeout(bookmarkRefreshTimer);
  bookmarkRefreshTimer = setTimeout(() => load().catch(showError), 180);
}
for (const eventName of ['onCreated', 'onChanged', 'onMoved', 'onRemoved', 'onChildrenReordered', 'onImportEnded']) {
  chrome.bookmarks?.[eventName]?.addListener(refreshBookmarks);
}
function showError(error) {
  const node = document.getElementById('start-error');
  node.textContent = '新标签页加载失败：' + error.message + '。请从扩展弹窗打开设置，或重新加载扩展。';
  node.hidden = false;
}
currentWindowId().then(id => { windowId = id; return load(); }).catch(showError);
