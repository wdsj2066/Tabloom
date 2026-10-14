import { ALARM_PREFIX, BATCH_SIZE } from '../core/config.js';
import { colorFor, isDomainExcluded, isPage } from '../core/validation.js';
import { eligibleTabs, groupNameKey, survivingIds } from '../core/plan.js';
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
  async logActivity(windowId, entry) {
    try { await this.repository.recordActivity?.(windowId, entry); } catch {}
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
      const candidates = (automatic ? eligibleTabs(allTabs) : allTabs.filter(tab => !tab.pinned && (tab.groupId === -1 || managedIds.has(tab.groupId)))).filter(tab => isPage(tab.url) && !isNativeNewTab(tab.url) && !isDomainExcluded(tab.url, settings.excludedDomains));
      if (!candidates.length) {
        const message = '没有待整理的页面，手动分组、排除域名和固定标签已保留。';
        if (!automatic) await this.logActivity(id, { id: crypto.randomUUID(), time: Date.now(), type: 'analysis', pages: 0, groups: 0, message });
        return { message, pages: 0, groups: 0 };
      }
      const targets = new Map();
      for (const group of native) {
        const key = groupNameKey(group.title);
        if (!targets.has(key)) targets.set(key, group.id);
      }
      const originalTabs = new Map(candidates.map(tab => [tab.id, { url: tab.url, groupId: tab.groupId, index: tab.index }]));
      const undo = {
        id: crypto.randomUUID(),
        time: Date.now(),
        initialManaged: [...tracked],
        originalGroups: native.map(group => ({ id: group.id, title: group.title || '未命名分组', color: group.color, collapsed: !!group.collapsed })),
        createdGroupIds: [],
        expectedGroupOrders: [],
        pages: []
      };
      const persistUndoSnapshot = async () => {
        if (!undo.pages.length) return;
        const currentTabs = await this.browser.tabs.query({ windowId: id });
        const groupIds = new Set(undo.pages.map(page => page.expectedGroupId));
        undo.expectedGroupOrders = [...groupIds].map(groupId => ({
          groupId,
          tabIds: currentTabs.filter(tab => tab.groupId === groupId).sort((a, b) => a.index - b.index).map(tab => tab.id)
        }));
        await this.repository.setUndoRecord?.(id, undo);
      };
      let pages = 0;
      const touched = new Set();
      try {
        for (let offset = 0; offset < candidates.length; offset += BATCH_SIZE) {
          signal.throwIfAborted();
          const current = new Map((await this.browser.tabs.query({ windowId: id })).map(tab => [tab.id, tab]));
          const batch = candidates.slice(offset, offset + BATCH_SIZE).filter(tab => {
            const live = current.get(tab.id);
            return live && live.groupId === tab.groupId && !live.pinned && live.url === tab.url;
          }).map(tab => current.get(tab.id));
          if (!batch.length) continue;
          const requestSettings = await this.repository.settings();
          const requestBatch = batch.filter(tab => !isDomainExcluded(tab.url, requestSettings.excludedDomains));
          if (!requestBatch.length) continue;
          const snapshot = new Map(requestBatch.map(tab => [tab.id, tab.url]));
          const initialGroups = new Map(requestBatch.map(tab => [tab.id, tab.groupId]));
          const context = (await this.browser.tabGroups.query({ windowId: id })).filter(group => managedIds.has(group.id)).map(group => ({
            name: group.title,
            pages: [...current.values()].filter(tab => tab.groupId === group.id && isPage(tab.url) && !isDomainExcluded(tab.url, requestSettings.excludedDomains)).slice(0, 2).map(tab => ({ title: tab.title || '', url: tab.url }))
          })).filter(group => group.pages.length);
          const tracking = {
            onRequest: model => Promise.resolve(this.repository.recordModelRequest?.(model)).catch(() => {}),
            onUsage: (usage, model) => Promise.resolve(this.repository.recordModelUsage?.(usage, model)).catch(() => {})
          };
          const plan = await this.classifier(requestSettings, requestBatch, context, signal, tracking);
          signal.throwIfAborted();
          if (automatic && !(await this.repository.settings()).automatic) {
            const message = '自动整理已关闭，已停止后续操作。';
            if (undo.pages.length) {
              await persistUndoSnapshot();
              await this.logActivity(id, { id: undo.id, time: undo.time, type: 'analysis', pages: undo.pages.length, groups: touched.size, message });
            }
            return { message, pages, groups: touched.size };
          }
          for (const entry of plan) {
            signal.throwIfAborted();
            const live = await this.browser.tabs.query({ windowId: id });
            const latestSettings = await this.repository.settings();
            const liveById = new Map(live.map(tab => [tab.id, tab]));
            const members = survivingIds(entry.ids, snapshot, live, initialGroups).filter(tabId => !isDomainExcluded(liveById.get(tabId)?.url, latestSettings.excludedDomains));
            if (!members.length) continue;
            const availableGroups = await this.browser.tabGroups.query({ windowId: id });
            const key = groupNameKey(entry.name);
            const previousId = targets.get(key);
            const targetId = availableGroups.find(group => group.id === previousId && groupNameKey(group.title) === key)?.id
              ?? availableGroups.find(group => managedIds.has(group.id) && groupNameKey(group.title) === key)?.id;
            const toGroup = targetId === undefined ? members : members.filter(tabId => liveById.get(tabId)?.groupId !== targetId);
            if (!toGroup.length) continue;
            const groupId = await this.browser.tabs.group(targetId === undefined ? { tabIds: toGroup, createProperties: { windowId: id } } : { tabIds: toGroup, groupId: targetId });
            if (targetId === undefined) undo.createdGroupIds.push(groupId);
            const movedMembers = members.filter(tabId => originalTabs.get(tabId)?.groupId !== groupId);
            for (const tabId of movedMembers) {
              const original = originalTabs.get(tabId);
              if (original && original.groupId !== groupId && !undo.pages.some(item => item.tabId === tabId)) {
                undo.pages.push({ tabId, url: original.url, originalGroupId: original.groupId, originalIndex: original.index, expectedGroupId: groupId });
              }
            }
            if (targetId === undefined) {
              await this.browser.tabGroups.update(groupId, { title: entry.name, color: colorFor(entry.name) });
            }
            targets.set(key, groupId);
            managedIds.add(groupId);
            touched.add(groupId);
            pages += movedMembers.length;
            const activeIds = new Set((await this.browser.tabGroups.query({ windowId: id })).map(group => group.id));
            await this.repository.setManaged(id, [...managedIds].filter(groupId => activeIds.has(groupId)));
            await persistUndoSnapshot();
          }
        }
        const message = pages ? '已将 ' + pages + ' 个页面整理到 ' + touched.size + ' 个主题组。' : '本次整理没有移动任何页面。';
        await persistUndoSnapshot();
        await this.logActivity(id, { id: undo.id, time: undo.time, type: 'analysis', pages: undo.pages.length, groups: touched.size, message });
        return { message, pages, groups: touched.size };
      } catch (error) {
        if (undo.pages.length) {
          await persistUndoSnapshot();
          const message = '整理已中断，已移动 ' + undo.pages.length + ' 个页面；可以撤销本次移动。';
          await this.logActivity(id, { id: undo.id, time: undo.time, type: 'analysis', pages: undo.pages.length, groups: touched.size, message, interrupted: true });
        }
        throw error;
      }
    });
  }
  undo(id) {
    return this.execute(id, 'organizing', async signal => {
      const record = await this.repository.undoRecord?.(id);
      if (!record?.pages?.length) throw new Error('当前窗口没有可撤销的整理记录。');
      const live = new Map((await this.browser.tabs.query({ windowId: id })).map(tab => [tab.id, tab]));
      const changedOrderGroups = new Set();
      for (const order of record.expectedGroupOrders || []) {
        const expected = order.tabIds.filter(tabId => live.get(tabId)?.groupId === order.groupId);
        const known = new Set(order.tabIds);
        const actual = [...live.values()].filter(tab => tab.groupId === order.groupId && known.has(tab.id)).sort((a, b) => a.index - b.index).map(tab => tab.id);
        if (expected.some((tabId, index) => tabId !== actual[index]) || expected.length !== actual.length) changedOrderGroups.add(order.groupId);
      }
      const unchanged = record.pages.filter(page => {
        const tab = live.get(page.tabId);
        return tab && tab.url === page.url && tab.groupId === page.expectedGroupId && !changedOrderGroups.has(page.expectedGroupId);
      });
      const skipped = record.pages.length - unchanged.length;
      const restored = new Set();
      const remappedGroups = new Map();
      const groups = new Map((await this.browser.tabGroups.query({ windowId: id })).map(group => [group.id, group]));
      const byOriginalGroup = new Map();
      for (const page of unchanged) {
        const key = page.originalGroupId;
        if (!byOriginalGroup.has(key)) byOriginalGroup.set(key, []);
        byOriginalGroup.get(key).push(page);
      }
      for (const [originalGroupId, pages] of byOriginalGroup) {
        signal.throwIfAborted();
        const ids = pages.map(page => page.tabId);
        try {
          if (originalGroupId === -1) {
            await this.browser.tabs.ungroup(ids);
          } else if (groups.has(originalGroupId)) {
            await this.browser.tabs.group({ tabIds: ids, groupId: originalGroupId });
          } else {
            const newGroupId = await this.browser.tabs.group({ tabIds: ids, createProperties: { windowId: id } });
            remappedGroups.set(originalGroupId, newGroupId);
            const original = record.originalGroups?.find(group => group.id === originalGroupId);
            if (original) {
              try { await this.browser.tabGroups.update(newGroupId, { title: original.title, color: original.color, collapsed: original.collapsed }); } catch {}
            }
          }
          for (const page of pages) restored.add(page.tabId);
        } catch {}
      }
      const restoreOrder = unchanged.filter(page => restored.has(page.tabId)).sort((a, b) => a.originalIndex - b.originalIndex);
      let orderFailures = 0;
      for (const page of restoreOrder) {
        try {
          const tabCount = (await this.browser.tabs.query({ windowId: id })).length;
          await this.browser.tabs.move(page.tabId, { index: Math.min(page.originalIndex, Math.max(tabCount - 1, 0)) });
        } catch { orderFailures += 1; }
      }
      const currentGroups = await this.browser.tabGroups.query({ windowId: id });
      const activeGroupIds = new Set(currentGroups.map(group => group.id));
      const createdGroupIds = record.createdGroupIds || [];
      const managed = new Set((await this.repository.managed(id)).filter(groupId => !createdGroupIds.includes(groupId) && activeGroupIds.has(groupId)));
      for (const oldId of record.initialManaged || []) {
        const groupId = remappedGroups.get(oldId) ?? oldId;
        if (activeGroupIds.has(groupId)) managed.add(groupId);
      }
      await this.repository.setManaged(id, [...managed]);
      const remaining = unchanged.filter(page => !restored.has(page.tabId));
      await this.repository.setUndoRecord?.(id, { ...record, pages: remaining });
      const message = restored.size
        ? '已撤销 ' + restored.size + ' 个页面的整理。' + (skipped ? '另有 ' + skipped + ' 个页面已关闭、网址变化、重新分组或调整顺序，已保留现状。' : '') + (orderFailures ? restored.size + ' 个页面中有 ' + orderFailures + ' 个未能恢复原顺序。' : '') + (remaining.length ? '仍有 ' + remaining.length + ' 个页面未能恢复，可重试。' : '')
        : skipped ? '没有可恢复的页面；已关闭、网址变化、重新分组或调整顺序的页面保持原样。' : '暂时无法恢复这些页面，请重试。';
      await this.logActivity(id, { id: crypto.randomUUID(), time: Date.now(), type: 'undo', pages: restored.size, groups: byOriginalGroup.size, message });
      return { message, pages: restored.size, groups: byOriginalGroup.size };
    });
  }
  cancel(id) {
    const job = this.jobs.get(id);
    job?.controller.abort();
    return job?.promise?.catch(() => {});
  }
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
      await this.repository.setUndoRecord?.(id, null);
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
      await this.repository.setUndoRecord?.(id, null);
      return { message: '已打开“' + saved.name + '”的 ' + created.length + ' 个页面。' };
    });
  }
  dissolve(id) {
    return this.execute(id, 'organizing', async () => {
      await this.repository.setAutomatic(false);
      const grouped = (await this.browser.tabs.query({ windowId: id })).filter(tab => tab.groupId !== -1).map(tab => tab.id);
      if (grouped.length) await this.browser.tabs.ungroup(grouped);
      await this.repository.setManaged(id, []);
      await this.repository.setUndoRecord?.(id, null);
      return { message: '已解散当前窗口分组，自动整理已关闭。固定组记录仍然保留。' };
    });
  }
  closeGroups(id) {
    return this.execute(id, 'organizing', async () => {
      const grouped = (await this.browser.tabs.query({ windowId: id })).filter(tab => tab.groupId !== -1).map(tab => tab.id);
      if (grouped.length) await this.browser.tabs.remove(grouped);
      await this.repository.setManaged(id, []);
      await this.repository.setUndoRecord?.(id, null);
      return { message: '已关闭当前窗口的分组标签，固定组记录仍然保留。' };
    });
  }
}
