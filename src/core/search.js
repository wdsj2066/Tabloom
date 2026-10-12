export const SEARCH_ENGINES = Object.freeze({
  bing: { label: 'Bing', endpoint: 'https://www.bing.com/search', parameter: 'q' },
  google: { label: 'Google', endpoint: 'https://www.google.com/search', parameter: 'q' },
  duckduckgo: { label: 'DuckDuckGo', endpoint: 'https://duckduckgo.com/', parameter: 'q' }
});

export function searchAddress(text, engine = 'bing') {
  const value = text.trim();
  if (!value) throw new Error('请输入搜索内容或网址。');
  const looksLikeAddress = /^https?:\/\//i.test(value) || /^[a-z\d.-]+\.[a-z]{2,}(?::\d+)?(?:[/?#]\S*)?$/i.test(value);
  if (looksLikeAddress) {
    const url = new URL(/^https?:\/\//i.test(value) ? value : 'https://' + value);
    if (url.username || url.password) throw new Error('网址中不能包含用户名或密码。');
    return url.href;
  }
  const provider = SEARCH_ENGINES[engine];
  if (!provider) throw new Error('请选择有效的搜索引擎。');
  const destination = new URL(provider.endpoint);
  destination.searchParams.set(provider.parameter, value);
  return destination.href;
}
