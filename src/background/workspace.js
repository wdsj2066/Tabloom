import { ALARM_PREFIX, BATCH_SIZE } from '../core/config.js';
import { colorFor, isPage } from '../core/validation.js';
import { eligibleTabs, survivingIds } from '../core/plan.js';
import { requestPlan } from '../core/model.js';
import { isNativeNewTab } from './newtab-router.js';

export class Workspace {
  constructor(browser, repository, classifier = requestPlan) {
    this.browser = browser;
    this.repository = repository;
    this.classifier = classifier;
    this.jobs = new Map();
  }
  async schedule(id) {
    if (id < 0) return;
    const settings = await this.repository.settings();
    if (!settings.automatic) return this.browser.alarms.clear(ALARM_PREFIX + id);
    const seconds = settings.settleSeconds ?? 20;
    return this.browser.alarms.create(ALARM_PREFIX + id, { when: Date.now() + seconds * 1000 });
  }
  async scheduleAll() {
    for (const window of await this.browser.windows.getAll({ windowTypes: ['normal'] })) await this.schedule(window.id);
  }
  execute(id, kind, work) {
    const prior = this.jobs.get(id);
    if (kind === 'analysis' && prior?.kind === kind) return prior.promise;
    if (prior) prior.controller.abort();
    const controller = new AbortController();
    const promise = (async () => {
      await prior?.promise.catch(() => {});
      controller.signal.throwIfAborted();
      await this.repository.setState(id, { phase: kind, message: kind === 'analysis' ? '正在分析页面主题…' : '正在整理分组…' });
      try {
        const result = await work(controller.signal);
        await this.repository.setState(id, { phase: 'idle', message: result.message, completedAt: Date.now() });
        return result;
      } catch (error) {
        await this.repository.setState(id, { phase: controller.signal.aborted ? 'idle' : 'error', message: controller.signal.aborted ? '操作已取消。' : error.message });
        throw error;
      }
    })().finally(() => { if (this.jobs.get(id)?.promise === promise) this.jobs.delete(id); });
    this.jobs.set(id, { kind, controller, promise });
    return promise;
  }
  async analyze(id, automatic = false) {
    const settings = await this.repository.settings();
    if (automatic && !settings.automatic) return { message: '自动整理已关闭。' };
    if (automatic && this.jobs.has(id)) { await this.schedule(id); return { message: '等待当前操作完成。' }; }
    return this.execute(id, 'analysis', async signal => {
      const tracked = new Set(await this.repository.managed(id));
      const native = (await this.browser.tabGroups.query({ windowId: id })).filter(group => tracked.has(group.id));
      const managedIds = new Set(native.map(group => group.id));
      const allTabs = await this.browser.tabs.query({ windowId: id });
      const candidates = (automatic ? eligibleTabs(allTabs) : allTabs.filter(tab => !tab.pinned && (tab.groupId === -1 || managedIds.has(tab.groupId)))).filter(tab => isPage(tab.url) && !isNativeNewTab(tab.url));
      if (!candidates.length) return { message: '没有待整理的页面，手动分组和固定标签已保留。', pages: 0, groups: 0 };
      const targets = new Map(native.map(group => [group.title, group.id]));
      let pages = 0;
      const touched = new Set();
      for (let offset = 0; offset < candidates.length; offset += BATCH_SIZE) {
        signal.throwIfAborted();
        const current = new Map((await this.browser.tabs.query({ windowId: id })).map(tab => [tab.id, tab]));
        const batch = candidates.slice(offset, offset + BATCH_SIZE).filter(tab => {
          const live = current.get(tab.id);
          return live && live.groupId === tab.groupId && !live.pinned && live.url === tab.url;
        }).map(tab => current.get(tab.id));
        if (!batch.length) continue;
        const snapshot = new Map(batch.map(tab => [tab.id, tab.url]));
        const initialGroups = new Map(batch.map(tab => [tab.id, tab.groupId]));
        const context = (await this.browser.tabGroups.query({ windowId: id })).filter(group => [...targets.values()].includes(group.id)).map(group => ({
          name: group.title,
          pages: [...current.values()].filter(tab => tab.groupId === group.id && isPage(tab.url)).slice(0, 2).map(tab => ({ title: tab.title || '', url: tab.url }))
        }));
        const tracking = {
          onRequest: () => Promise.resolve(this.repository.recordModelRequest?.()).catch(() => {}),
          onUsage: usage => Promise.resolve(this.repository.recordModelUsage?.(usage)).catch(() => {})
        };
        const plan = await this.classifier(settings, batch, context, signal, tracking);
        signal.throwIfAborted();
        if (automatic && !(await this.repository.settings()).automatic) return { message: '自动整理已关闭，已停止后续操作。', pages, groups: touched.size };
        for (const entry of plan) {
          signal.throwIfAborted();
          const live = await this.browser.tabs.query({ windowId: id });
          const members = survivingIds(entry.ids, snapshot, live, initialGroups);
          if (!members.length) continue;
          const availableGroups = await this.browser.tabGroups.query({ windowId: id });
          const previousId = targets.get(entry.name);
          const targetId = availableGroups.some(group => group.id === previousId && group.title === entry.name) ? previousId : undefined;
          const groupId = await this.browser.tabs.group(targetId === undefined ? { tabIds: members, createProperties: { windowId: id } } : { tabIds: members, groupId: targetId });
          if (targetId === undefined) {
            await this.browser.tabGroups.update(groupId, { title: entry.name, color: colorFor(entry.name) });
            targets.set(entry.name, groupId);
          }
          touched.add(groupId);
          pages += members.length;
          await this.repository.setManaged(id, [...new Set([...targets.values()])]);
        }
      }
      return { message: pages ? '已将 ' + pages + ' 个页面整理到 ' + touched.size + ' 个主题组。' : '页面已发生变化，没有移动任何标签。', pages, groups: touched.size };
    });
  }
  cancel(id) { this.jobs.get(id)?.controller.abort(); }
  async currentGroups(id) {
    const [groups, tabs] = await Promise.all([this.browser.tabGroups.query({ windowId: id }), this.browser.tabs.query({ windowId: id })]);
    return groups.map(group => ({ id: group.id, name: group.title || '未命名分组', color: group.color, pages: tabs.filter(tab => tab.groupId === group.id && isPage(tab.url)).sort((a, b) => a.index - b.index).map(tab => ({ url: tab.url, title: tab.title || '' })) }));
  }
  saveNative(id, groupId) {
    return this.execute(id, 'saving', async () => {
      const group = (await this.currentGroups(id)).find(item => item.id === groupId);
      if (!group) throw new Error('该浏览器分组已不存在，请刷新列表。');
      const collectionId = await this.repository.putCollection({ name: group.name, color: group.color, pages: group.pages });
      // 保存为固定组后，不再把这个浏览器组视作可追加标签的 AI 组。
      await this.repository.setManaged(id, (await this.repository.managed(id)).filter(value => value !== groupId));
      return { message: '已固定“' + group.name + '”。', id: collectionId };
    });
  }
  openSaved(id, collectionId) {
    return this.execute(id, 'opening', async signal => {
      const saved = (await this.repository.library()).find(item => item.id === collectionId);
      if (!saved) throw new Error('找不到这个固定组，请刷新页面。');
      const created = [];
      let nativeId;
      try {
        for (const page of saved.pages) {
          signal.throwIfAborted();
          const tab = await this.browser.tabs.create({ windowId: id, url: page.url, active: false });
          created.push(tab.id);
          nativeId = await this.browser.tabs.group(nativeId === undefined ? { tabIds: [tab.id], createProperties: { windowId: id } } : { tabIds: [tab.id], groupId: nativeId });
        }
        await this.browser.tabGroups.update(nativeId, { title: saved.name, color: saved.color, collapsed: false });
        await this.browser.tabs.update(created[0], { active: true });
      } catch (error) {
        // 恢复失败时只回滚本次新建的标签，避免残留半个固定组。
        for (const tabId of created) { try { await this.browser.tabs.remove(tabId); } catch {} }
        throw error;
      }
      return { message: '已打开“' + saved.name + '”的 ' + created.length + ' 个页面。' };
    });
  }
  dissolve(id) {
    return this.execute(id, 'organizing', async () => {
      await this.repository.setAutomatic(false);
      const grouped = (await this.browser.tabs.query({ windowId: id })).filter(tab => tab.groupId !== -1).map(tab => tab.id);
      if (grouped.length) await this.browser.tabs.ungroup(grouped);
      await this.repository.setManaged(id, []);
      return { message: '已解散当前窗口分组，自动整理已关闭。固定组记录仍然保留。' };
    });
  }
  closeGroups(id) {
    return this.execute(id, 'organizing', async () => {
      const grouped = (await this.browser.tabs.query({ windowId: id })).filter(tab => tab.groupId !== -1).map(tab => tab.id);
      if (grouped.length) await this.browser.tabs.remove(grouped);
      await this.repository.setManaged(id, []);
      return { message: '已关闭当前窗口的分组标签，固定组记录仍然保留。' };
    });
  }
}
