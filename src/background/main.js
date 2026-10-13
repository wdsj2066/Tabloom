import { ALARM_PREFIX, KEYS } from '../core/config.js';
import { Repository } from './repository.js';
import { Workspace } from './workspace.js';
import { isDomainExcluded, isPage } from '../core/validation.js';
import { NewTabRouter, isNativeNewTab } from './newtab-router.js';

const repository = new Repository();
const workspace = new Workspace(chrome, repository);
const newTabs = new NewTabRouter(chrome, repository);
const quietly = promise => Promise.resolve(promise).catch(() => {});

function browserBookmarkGroups(tree) {
  const root = tree?.[0];
  const groups = [];
  function visit(folder, parents = []) {
    if (!folder || folder.url) return;
    const name = String(folder.title || '').trim() || '未命名收藏夹';
    const pages = (folder.children || []).flatMap(node => {
      if (!node.url) return [];
      try {
        const url = new URL(node.url);
        if (!['http:', 'https:'].includes(url.protocol)) return [];
        return [{ title: String(node.title || '').trim(), url: url.href }];
      } catch { return []; }
    });
    if (folder !== root && pages.length) groups.push({ name, path: parents.join(' / '), pageCount: pages.length, pages });
    const nextParents = folder === root ? parents : [...parents, name];
    for (const child of folder.children || []) if (!child.url) visit(child, nextParents);
  }
  if (root) visit(root);
  return groups;
}

chrome.tabs.onCreated.addListener(tab => {
  quietly(newTabs.handle(tab));
  if (!tab.pinned && tab.groupId === -1 && isPage(tab.url || tab.pendingUrl) && !isNativeNewTab(tab.url || tab.pendingUrl)) quietly(workspace.schedule(tab.windowId));
});
chrome.tabs.onUpdated.addListener((id, delta, tab) => {
  if (delta.url || delta.status === 'complete') quietly(newTabs.handle(tab));
  if (!tab.pinned && tab.groupId === -1 && isPage(tab.url) && !isNativeNewTab(tab.url) && (delta.url || delta.status === 'complete')) quietly(workspace.schedule(tab.windowId));
});
// 关闭标签无需新增或推迟分析任务；已有任务在请求前查询仍存在的页面。
chrome.windows.onRemoved.addListener(id => {
  const stopped = workspace.cancel(id);
  quietly(chrome.alarms.clear(ALARM_PREFIX + id));
  quietly(repository.clearWindow(id));
  quietly(Promise.resolve(stopped).then(() => repository.clearWindow(id)));
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name.startsWith(ALARM_PREFIX)) quietly(workspace.analyze(Number(alarm.name.slice(ALARM_PREFIX.length)), true));
});
chrome.runtime.onInstalled.addListener(() => quietly(repository.initialize().then(() => workspace.scheduleAll())));
chrome.runtime.onStartup.addListener(() => quietly(workspace.scheduleAll()));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[KEYS.preferences]) quietly(workspace.scheduleAll());
});

async function dispatch(message) {
  const windowId = message.windowId;
  const windowActions = ['dashboard', 'analyze', 'undo', 'save-native', 'open-saved', 'dissolve', 'close-groups', 'cancel'];
  if (windowActions.includes(message.action) && (!Number.isInteger(windowId) || windowId < 0)) throw new Error('无法确定当前浏览器窗口。');
  switch (message.action) {
    case 'dashboard': {
      const [settings, library, groups, state, tabs, appearance, usage, theme, activity, undo, pricing] = await Promise.all([repository.settings(), repository.library(), workspace.currentGroups(windowId), repository.state(windowId), chrome.tabs.query({ windowId }), repository.appearance(), repository.usage(), repository.theme(), repository.activities(), repository.undoRecord(windowId), repository.pricing()]);
      const active = workspace.jobs.has(windowId);
      return { settings, appearance, theme, library, groups, usage, activity: activity.filter(item => item.windowId === windowId), undo, pricing, state: active || !['analysis', 'opening', 'saving', 'organizing'].includes(state.phase) ? state : { phase: 'idle', message: '上一项任务已结束，可以重新整理。' }, tabCount: tabs.length, pendingCount: tabs.filter(tab => tab.groupId === -1 && !tab.pinned && /^https?:\/\//i.test(tab.url || '') && !isNativeNewTab(tab.url) && !isDomainExcluded(tab.url, settings.excludedDomains)).length };
    }
    case 'save-settings': return repository.saveSettings(message.value);
    case 'save-pricing': return repository.savePricing(message.value);
    case 'save-appearance': return repository.saveAppearance(message.value);
    case 'save-theme': return repository.saveTheme(message.value);
    case 'start-page': {
      const bookmarkGroups = chrome.bookmarks?.getTree
        ? chrome.bookmarks.getTree().then(browserBookmarkGroups).catch(() => [])
        : Promise.resolve([]);
      const [appearance, library, theme, bookmarks] = await Promise.all([repository.appearance(), repository.library(), repository.theme(), bookmarkGroups]);
      return { appearance, library, theme, bookmarks };
    }
    case 'set-automatic': await repository.setAutomatic(message.value); return { message: message.value ? '已开启自动整理。' : '已关闭自动整理。' };
    case 'analyze': return workspace.analyze(windowId);
    case 'undo': return workspace.undo(windowId);
    case 'cancel': workspace.cancel(windowId); return { message: '已请求停止整理。' };
    case 'save-native': return workspace.saveNative(windowId, message.groupId);
    case 'save-collection': return { id: await repository.putCollection(message.value), message: '固定组已保存。' };
    case 'import-collections': {
      const count = await repository.importCollections(message.collections);
      return { count, message: '已导入 ' + count + ' 个固定组。' };
    }
    case 'delete-collection': await repository.deleteCollection(message.id); return { message: '已删除保存记录，已打开的标签不受影响。' };
    case 'open-saved': return workspace.openSaved(windowId, message.id);
    case 'dissolve': return workspace.dissolve(windowId);
    case 'close-groups': return workspace.closeGroups(windowId);
    default: throw new Error('不支持的操作。');
  }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || message?.channel !== 'tabloom') return;
  dispatch(message).then(value => reply({ success: true, value })).catch(error => reply({ success: false, error: error.name === 'AbortError' ? '操作已取消。' : error.message }));
  return true;
});
