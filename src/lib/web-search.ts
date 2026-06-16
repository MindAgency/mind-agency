/**
 * Web search facade for agents.
 *
 * Mature agent projects usually separate search retrieval from browser control.
 * This module implements the retrieval layer first: provider routing, citations,
 * and a small synthesis-ready result format.
 */

import { isToolEnabled } from './tool-registry';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
  provider: string;
}

export interface WebSearchResponse {
  query: string;
  provider: string;
  results: WebSearchResult[];
  citations: string[];
}

function env(name: string): string {
  return process.env[name] || '';
}

async function searchTavily(query: string, maxResults: number): Promise<WebSearchResult[]> {
  const apiKey = env('TAVILY_API_KEY');
  if (!apiKey) throw new Error('TAVILY_API_KEY is not configured');
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults, search_depth: 'advanced' }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Tavily ${res.status}`);
  return (data.results || []).map((r: any) => ({
    title: r.title || r.url || 'Untitled',
    url: r.url,
    snippet: r.content || r.snippet || '',
    publishedAt: r.published_date,
    provider: 'tavily',
  }));
}

async function searchExa(query: string, maxResults: number): Promise<WebSearchResult[]> {
  const apiKey = env('EXA_API_KEY');
  if (!apiKey) throw new Error('EXA_API_KEY is not configured');
  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ query, numResults: maxResults, useAutoprompt: true }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Exa ${res.status}`);
  return (data.results || []).map((r: any) => ({
    title: r.title || r.url || 'Untitled',
    url: r.url,
    snippet: r.text || r.summary || '',
    publishedAt: r.publishedDate,
    provider: 'exa',
  }));
}

async function searchBrave(query: string, maxResults: number): Promise<WebSearchResult[]> {
  const apiKey = env('BRAVE_SEARCH_API_KEY');
  if (!apiKey) throw new Error('BRAVE_SEARCH_API_KEY is not configured');
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(maxResults));
  const res = await fetch(url, { headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Brave ${res.status}`);
  return (data.web?.results || []).map((r: any) => ({
    title: r.title || r.url || 'Untitled',
    url: r.url,
    snippet: r.description || '',
    publishedAt: r.age,
    provider: 'brave',
  }));
}

function chooseProvider(preferred?: string): string {
  if (preferred) return preferred;
  if (env('TAVILY_API_KEY')) return 'tavily';
  if (env('EXA_API_KEY')) return 'exa';
  if (env('BRAVE_SEARCH_API_KEY')) return 'brave';
  return 'none';
}

export async function runWebSearch(query: string, opts?: { provider?: string; maxResults?: number }): Promise<WebSearchResponse> {
  if (!isToolEnabled('web_search')) {
    throw new Error('web_search tool is disabled. Enable it in the tool registry first.');
  }
  const provider = chooseProvider(opts?.provider);
  const maxResults = Math.max(1, Math.min(opts?.maxResults || 5, 10));
  let results: WebSearchResult[];

  if (provider === 'tavily') results = await searchTavily(query, maxResults);
  else if (provider === 'exa') results = await searchExa(query, maxResults);
  else if (provider === 'brave') results = await searchBrave(query, maxResults);
  else throw new Error('No web search provider configured. Set TAVILY_API_KEY, EXA_API_KEY, or BRAVE_SEARCH_API_KEY.');

  const citations = results.map((r, i) => `[${i + 1}] ${r.title} - ${r.url}`);
  return { query, provider, results, citations };
}
