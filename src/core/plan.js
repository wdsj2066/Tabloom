export function readPlan(text, candidates) {
  if (typeof text !== 'string') throw new Error('模型没有返回文本内容。');
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let document;
  try { document = JSON.parse(trimmed); } catch { throw new Error('模型回复不是有效 JSON，请重试或更换模型。'); }
  if (!document || !Array.isArray(document.collections)) throw new Error('模型回复缺少 collections 分组列表。');
  const allowed = new Set(candidates.map(item => item.id));
  const assigned = new Set();
  const merged = new Map();
  for (const item of document.collections) {
    if (!item || typeof item.name !== 'string' || !item.name.trim() || !Array.isArray(item.ids) || !item.ids.length) {
      throw new Error('模型返回了不完整的分组。');
    }
    const name = item.name.trim().slice(0, 60);
    const members = merged.get(name) || [];
    for (const id of item.ids) {
      if (!Number.isInteger(id) || !allowed.has(id) || assigned.has(id)) throw new Error('模型回复包含未知或重复的标签 ID。');
      assigned.add(id);
      members.push(id);
    }
    merged.set(name, members);
  }
  if (assigned.size !== allowed.size) throw new Error('模型遗漏了部分标签，请重试。');
  return [...merged].map(([name, ids]) => ({ name, ids }));
}

export function eligibleTabs(tabs) {
  return tabs.filter(tab => !tab.pinned && tab.groupId === -1 && /^https?:\/\//i.test(tab.url || ''));
}

export function survivingIds(planIds, snapshot, liveTabs, initialGroups = new Map()) {
  const live = new Map(liveTabs.map(tab => [tab.id, tab]));
  return planIds.filter(id => {
    const tab = live.get(id);
    return tab && tab.groupId === (initialGroups.get(id) ?? -1) && !tab.pinned && snapshot.get(id) === tab.url;
  });
}
