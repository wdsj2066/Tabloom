import { DEFAULT_APPEARANCE, DEFAULT_PREFERENCES, KEYS } from '../core/config.js';
import { appearance, collection, preferences } from '../core/validation.js';

export class Repository {
  constructor(local = chrome.storage.local, session = chrome.storage.session) {
    this.local = local;
    this.session = session;
    this.writes = Promise.resolve();
    this.usageWrites = Promise.resolve();
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
  async usage() {
    const stored = (await this.local.get(KEYS.usage))[KEYS.usage] || {};
    return {
      requests: Number.isSafeInteger(stored.requests) && stored.requests >= 0 ? stored.requests : 0,
      promptTokens: Number.isSafeInteger(stored.promptTokens) && stored.promptTokens >= 0 ? stored.promptTokens : 0,
      completionTokens: Number.isSafeInteger(stored.completionTokens) && stored.completionTokens >= 0 ? stored.completionTokens : 0,
      totalTokens: Number.isSafeInteger(stored.totalTokens) && stored.totalTokens >= 0 ? stored.totalTokens : 0,
      usageResponses: Number.isSafeInteger(stored.usageResponses) && stored.usageResponses >= 0 ? stored.usageResponses : 0,
      promptResponses: Number.isSafeInteger(stored.promptResponses) && stored.promptResponses >= 0 ? stored.promptResponses : 0,
      completionResponses: Number.isSafeInteger(stored.completionResponses) && stored.completionResponses >= 0 ? stored.completionResponses : 0,
      totalResponses: Number.isSafeInteger(stored.totalResponses) && stored.totalResponses >= 0 ? stored.totalResponses : 0
    };
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
    return this.updateUsage(current => ({ ...current, requests: current.requests + 1 }));
  }
  recordModelUsage(usage) {
    return this.updateUsage(current => ({
      ...current,
      promptTokens: current.promptTokens + (usage.promptTokens ?? 0),
      completionTokens: current.completionTokens + (usage.completionTokens ?? 0),
      totalTokens: current.totalTokens + (usage.totalTokens ?? 0),
      usageResponses: current.usageResponses + 1,
      promptResponses: current.promptResponses + (usage.promptTokens === null ? 0 : 1),
      completionResponses: current.completionResponses + (usage.completionTokens === null ? 0 : 1),
      totalResponses: current.totalResponses + (usage.totalTokens === null ? 0 : 1)
    }));
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
  deleteCollection(id) { return this.mutateLibrary(items => items.filter(item => item.id !== id)); }
  async managed(windowId) { return (await this.session.get('managed.' + windowId))['managed.' + windowId] || []; }
  setManaged(windowId, ids) { return this.session.set({ ['managed.' + windowId]: ids }); }
  async state(windowId) { return (await this.session.get('state.' + windowId))['state.' + windowId] || { phase: 'idle' }; }
  setState(windowId, value) { return this.session.set({ ['state.' + windowId]: { ...value, updatedAt: Date.now() } }); }
  clearWindow(windowId) { return this.session.remove(['managed.' + windowId, 'state.' + windowId]); }
}
