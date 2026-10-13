import { DEFAULT_APPEARANCE, DEFAULT_PREFERENCES, DEFAULT_THEME, KEYS } from '../core/config.js';
import { appearance, collection, preferences } from '../core/validation.js';

function localDate(value = new Date()) {
  const offset = value.getTimezoneOffset();
  return new Date(value.getTime() - offset * 60_000).toISOString().slice(0, 10);
}

export class Repository {
  constructor(local = chrome.storage.local, session = chrome.storage.session) {
    this.local = local;
    this.session = session;
    this.writes = Promise.resolve();
    this.usageWrites = Promise.resolve();
    this.activityWrites = Promise.resolve();
    this.initializing = null;
  }
  initialize() {
    this.initializing ||= this.migrate();
    return this.initializing;
  }
  async migrate() {
    const data = await this.local.get([KEYS.migrated, KEYS.preferences, KEYS.library, 'modelSettings', 'savedGroups']);
    if (data[KEYS.migrated]) return;
    const changes = { [KEYS.migrated]: true };
    if (!data[KEYS.preferences]) {
      const previous = data.modelSettings;
      changes[KEYS.preferences] = previous ? { ...DEFAULT_PREFERENCES, endpoint: previous.endpoint || '', model: previous.model || '', secret: previous.apiKey || '', automatic: !!previous.autoEnabled, guidance: previous.instructions || '' } : { ...DEFAULT_PREFERENCES };
    }
    if (!data[KEYS.library]) {
      changes[KEYS.library] = (data.savedGroups || []).flatMap(item => {
        try { return [{ ...collection({ name: item.title, color: item.color, pages: item.tabs }), id: crypto.randomUUID(), createdAt: Date.now(), updatedAt: Date.now() }]; } catch { return []; }
      });
    }
    await this.local.set(changes);
  }
  async settings() {
    await this.initialize();
    return { ...DEFAULT_PREFERENCES, ...(await this.local.get(KEYS.preferences))[KEYS.preferences] };
  }
  async appearance() {
    return { ...DEFAULT_APPEARANCE, ...(await this.local.get(KEYS.appearance))[KEYS.appearance] };
  }
  async theme() {
    const value = (await this.local.get(KEYS.theme))[KEYS.theme];
    if (value === 'light' || value === 'dark') return { ...DEFAULT_THEME, mode: value };
    return {
      mode: value?.mode === 'light' || value?.mode === 'dark' ? value.mode : DEFAULT_THEME.mode,
      accent: ['blue', 'green', 'purple', 'graphite'].includes(value?.accent) ? value.accent : DEFAULT_THEME.accent
    };
  }
  async saveTheme(value) {
    if (!['light', 'dark'].includes(value?.mode) || !['blue', 'green', 'purple', 'graphite'].includes(value?.accent)) throw new Error('请选择有效的主题颜色。');
    const theme = { mode: value.mode, accent: value.accent };
    await this.local.set({ [KEYS.theme]: theme });
    return theme;
  }
  async usage() {
    const stored = (await this.local.get(KEYS.usage))[KEYS.usage] || {};
    const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
    const daily = (Array.isArray(stored.daily) ? stored.daily : []).filter(item => item && /^\d{4}-\d{2}-\d{2}$/.test(item.date || '')).map(item => ({
      date: item.date,
      requests: count(item.requests),
      promptTokens: count(item.promptTokens),
      completionTokens: count(item.completionTokens),
      totalTokens: count(item.totalTokens),
      usageResponses: count(item.usageResponses),
      totalResponses: count(item.totalResponses)
    })).sort((a, b) => a.date.localeCompare(b.date)).slice(-90);
    return {
      requests: count(stored.requests),
      promptTokens: count(stored.promptTokens),
      completionTokens: count(stored.completionTokens),
      totalTokens: count(stored.totalTokens),
      usageResponses: count(stored.usageResponses),
      promptResponses: count(stored.promptResponses),
      completionResponses: count(stored.completionResponses),
      totalResponses: count(stored.totalResponses),
      daily
    };
  }
  async pricing() {
    const stored = (await this.local.get(KEYS.pricing))[KEYS.pricing] || {};
    const rate = value => Number.isFinite(value) && value >= 0 ? value : null;
    return { inputPerMillion: rate(stored.inputPerMillion), outputPerMillion: rate(stored.outputPerMillion), currency: String(stored.currency || '¥').trim().slice(0, 8) || '¥' };
  }
  async savePricing(input = {}) {
    input = input && typeof input === 'object' ? input : {};
    const parseRate = value => value === '' || value === null || value === undefined ? null : Number(value);
    const inputPerMillion = parseRate(input.inputPerMillion);
    const outputPerMillion = parseRate(input.outputPerMillion);
    if ([inputPerMillion, outputPerMillion].some(value => value !== null && (!Number.isFinite(value) || value < 0 || value > 1_000_000))) throw new Error('单价必须是 0 到 1,000,000 之间的数字。');
    if ((inputPerMillion === null) !== (outputPerMillion === null)) throw new Error('请同时填写输入和输出单价，或都留空以关闭估算。');
    const currency = String(input.currency || '').trim().slice(0, 8) || '¥';
    const pricing = { inputPerMillion, outputPerMillion, currency };
    await this.local.set({ [KEYS.pricing]: pricing });
    return pricing;
  }
  updateUsage(update) {
    const transaction = this.usageWrites.then(async () => {
      const current = await this.usage();
      const next = update(current);
      await this.local.set({ [KEYS.usage]: next });
      return next;
    });
    this.usageWrites = transaction.catch(() => {});
    return transaction;
  }
  recordModelRequest() {
    return this.updateUsage(current => {
      const date = localDate();
      const daily = current.daily.filter(item => item.date !== date);
      const today = current.daily.find(item => item.date === date) || { date, requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, usageResponses: 0, totalResponses: 0 };
      daily.push({ ...today, requests: today.requests + 1 });
      return { ...current, requests: current.requests + 1, daily: daily.sort((a, b) => a.date.localeCompare(b.date)).slice(-90) };
    });
  }
  recordModelUsage(usage) {
    return this.updateUsage(current => {
      const promptTokens = usage.promptTokens ?? 0;
      const completionTokens = usage.completionTokens ?? 0;
      const totalTokens = usage.totalTokens ?? 0;
      const date = localDate();
      const daily = current.daily.filter(item => item.date !== date);
      const today = current.daily.find(item => item.date === date) || { date, requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, usageResponses: 0, totalResponses: 0 };
      daily.push({
        ...today,
        promptTokens: today.promptTokens + promptTokens,
        completionTokens: today.completionTokens + completionTokens,
        totalTokens: today.totalTokens + totalTokens,
        usageResponses: today.usageResponses + 1,
        totalResponses: today.totalResponses + (usage.totalTokens === null ? 0 : 1)
      });
      return {
        ...current,
        promptTokens: current.promptTokens + promptTokens,
        completionTokens: current.completionTokens + completionTokens,
        totalTokens: current.totalTokens + totalTokens,
        usageResponses: current.usageResponses + 1,
        promptResponses: current.promptResponses + (usage.promptTokens === null ? 0 : 1),
        completionResponses: current.completionResponses + (usage.completionTokens === null ? 0 : 1),
        totalResponses: current.totalResponses + (usage.totalTokens === null ? 0 : 1),
        daily: daily.sort((a, b) => a.date.localeCompare(b.date)).slice(-90)
      };
    });
  }
  async activities() {
    const history = (await this.local.get(KEYS.activity))[KEYS.activity];
    return Array.isArray(history) ? history : [];
  }
  recordActivity(windowId, entry) {
    const transaction = this.activityWrites.then(async () => {
      const history = await this.activities();
      const next = [{ ...entry, windowId }, ...history].slice(0, 30);
      await this.local.set({ [KEYS.activity]: next });
      return next;
    });
    this.activityWrites = transaction.catch(() => {});
    return transaction;
  }
  async undoRecord(windowId) { return (await this.session.get('undo.' + windowId))['undo.' + windowId] || null; }
  async setUndoRecord(windowId, record) {
    const key = 'undo.' + windowId;
    if (record?.pages?.length) await this.session.set({ [key]: record });
    else await this.session.remove(key);
  }
  async saveAppearance(value) {
    const validated = appearance(value);
    await this.local.set({ [KEYS.appearance]: validated });
    return validated;
  }
  async saveSettings(value) {
    await this.initialize();
    const validated = preferences(value);
    await this.local.set({ [KEYS.preferences]: validated });
    return validated;
  }
  async setAutomatic(enabled) {
    const value = await this.settings();
    await this.local.set({ [KEYS.preferences]: { ...value, automatic: !!enabled } });
  }
  async library() {
    await this.initialize();
    return (await this.local.get(KEYS.library))[KEYS.library] || [];
  }
  mutateLibrary(transform) {
    const transaction = this.writes.then(async () => {
      const result = await transform(await this.library());
      await this.local.set({ [KEYS.library]: result });
      return result;
    });
    this.writes = transaction.catch(() => {});
    return transaction;
  }
  async putCollection(input) {
    const validated = collection(input);
    const id = input.id || crypto.randomUUID();
    await this.mutateLibrary(items => {
      const previous = items.find(item => item.id === id);
      if (input.id && !previous) throw new Error('该固定组已被删除，请刷新页面。');
      const record = { ...validated, id, createdAt: previous?.createdAt || Date.now(), updatedAt: Date.now() };
      return previous ? items.map(item => item.id === id ? record : item) : [...items, record];
    });
    return id;
  }
  async importCollections(inputs) {
    if (!Array.isArray(inputs) || inputs.length > 500) throw new Error('导入文件最多包含 500 个固定组。');
    const validated = inputs.map((item, index) => {
      try { return collection(item); }
      catch (error) { throw new Error('第 ' + (index + 1) + ' 个固定组无效：' + error.message); }
    });
    const now = Date.now();
    const records = validated.map(item => ({ ...item, id: crypto.randomUUID(), createdAt: now, updatedAt: now }));
    await this.mutateLibrary(items => [...items, ...records]);
    return records.length;
  }
  deleteCollection(id) { return this.mutateLibrary(items => items.filter(item => item.id !== id)); }
  async managed(windowId) { return (await this.session.get('managed.' + windowId))['managed.' + windowId] || []; }
  setManaged(windowId, ids) { return this.session.set({ ['managed.' + windowId]: ids }); }
  async state(windowId) { return (await this.session.get('state.' + windowId))['state.' + windowId] || { phase: 'idle' }; }
  setState(windowId, value) { return this.session.set({ ['state.' + windowId]: { ...value, updatedAt: Date.now() } }); }
  clearWindow(windowId) { return this.session.remove(['managed.' + windowId, 'state.' + windowId, 'undo.' + windowId]); }
}
