import { DEFAULT_APPEARANCE, DEFAULT_PREFERENCES, PALETTE } from './config.js';
import { SEARCH_ENGINES } from './search.js';

export function appearance(input = {}) {
  const result = { ...DEFAULT_APPEARANCE, ...input };
  if (!Object.hasOwn(SEARCH_ENGINES, result.searchEngine)) throw new Error('请选择有效的搜索引擎。');
  return { newTabEnabled: !!result.newTabEnabled, searchEngine: result.searchEngine };
}

export function pageAddress(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('请输入完整有效的网址。'); }
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('网址仅支持 HTTP 或 HTTPS。');
  if (parsed.username || parsed.password) throw new Error('网址中不能包含用户名或密码。');
  return parsed.href;
}

export function isPage(value) {
  try { pageAddress(value); return true; } catch { return false; }
}

export function modelAddress(value) {
  const parsed = new URL(pageAddress(String(value).trim()));
  if (parsed.search || parsed.hash) throw new Error('模型接口地址不能包含查询参数或片段。');
  let pathname = parsed.pathname.replace(/\/+$/, '');
  if (!pathname.endsWith('/chat/completions')) pathname += pathname.endsWith('/v1') ? '/chat/completions' : '/v1/chat/completions';
  parsed.pathname = pathname;
  return parsed.href;
}

export function preferences(input = {}) {
  const result = { ...DEFAULT_PREFERENCES, ...input };
  result.endpoint = modelAddress(result.endpoint);
  result.model = String(result.model).trim();
  result.secret = String(result.secret).trim();
  result.guidance = String(result.guidance).trim().slice(0, 4000);
  result.automatic = !!result.automatic;
  result.includeQuery = !!result.includeQuery;
  result.settleSeconds = Number(result.settleSeconds);
  if (!Number.isInteger(result.settleSeconds) || result.settleSeconds < 5 || result.settleSeconds > 300) throw new Error('自动整理等待时间必须是 5–300 秒的整数。');
  if (!result.model) throw new Error('请填写模型名称。');
  return result;
}

export function collection(input) {
  const name = String(input.name || '').trim().slice(0, 60);
  if (!name) throw new Error('给固定组起一个名字。');
  if (!Array.isArray(input.pages) || input.pages.length === 0) throw new Error('固定组至少需要一个页面。');
  if (input.pages.length > 300) throw new Error('每个固定组最多保存 300 个页面。');
  const pages = input.pages.map(page => ({ url: pageAddress(page.url), title: String(page.title || '').slice(0, 200) }));
  return { name, color: PALETTE.includes(input.color) ? input.color : 'blue', pages };
}

export function disclosureUrl(raw, includeQuery) {
  const parsed = new URL(raw);
  parsed.hash = '';
  if (!includeQuery) parsed.search = '';
  return parsed.href;
}

export function colorFor(name) {
  let value = 2166136261;
  for (const character of name) value = Math.imul(value ^ character.codePointAt(0), 16777619);
  return PALETTE[(value >>> 0) % PALETTE.length];
}
