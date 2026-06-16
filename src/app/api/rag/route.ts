/**
 * RAG API — Indexing and search management
 */

import { NextRequest } from 'next/server';
import {
  indexAll,
  indexAgentMemory,
  indexAgentSkills,
  indexAgentKnowledge,
  indexGroupKnowledge,
  indexSessionContext,
  search,
  ragQuery,
  clearCollection,
  getCollectionStats,
} from '@/lib/rag';
import { apiOk, apiBadRequest, apiInternal } from '@/lib/api-utils';

// GET /api/rag?agent=X&query=Y — Search
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const agent = searchParams.get('agent');
    const query = searchParams.get('query');
    const group = searchParams.get('group') || undefined;
    const topK = parseInt(searchParams.get('topK') || '5');
    const action = searchParams.get('action');

    // Stats action
    if (action === 'stats') {
      const stats = await getCollectionStats();
      return apiOk(stats as Record<string, unknown>);
    }

    if (!agent || !query) {
      return apiBadRequest('agent and query required');
    }

    const results = await search(query, { topK, rerank: true });

    return apiOk({
      results: results.map(r => ({
        id: r.document.id,
        content: r.document.content.slice(0, 500),
        source: r.document.metadata.source,
        score: r.score,
      })),
    });
  } catch (error: any) {
    return apiInternal(error.message);
  }
}

// POST /api/rag — Index or clear
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action, agent, group, messages } = body;

    if (!action) {
      return apiBadRequest('action required');
    }

    switch (action) {
      case 'index_all': {
        if (!agent) {
          return apiBadRequest('agent required for index_all');
        }
        const stats = await indexAll(agent, group);
        return apiOk(stats as Record<string, unknown>);
      }

      case 'index_memory': {
        if (!agent) {
          return apiBadRequest('agent required');
        }
        const count = await indexAgentMemory(agent);
        return apiOk({ indexed: count });
      }

      case 'index_skills': {
        if (!agent) {
          return apiBadRequest('agent required');
        }
        const count = await indexAgentSkills(agent);
        return apiOk({ indexed: count });
      }

      case 'index_knowledge': {
        if (!agent) {
          return apiBadRequest('agent required');
        }
        const count = await indexAgentKnowledge(agent);
        return apiOk({ indexed: count });
      }

      case 'index_group_knowledge': {
        if (!group) {
          return apiBadRequest('group required');
        }
        const count = await indexGroupKnowledge(group);
        return apiOk({ indexed: count });
      }

      case 'index_session': {
        if (!agent || !messages) {
          return apiBadRequest('agent and messages required');
        }
        await indexSessionContext(agent, messages);
        return apiOk();
      }

      case 'clear': {
        await clearCollection();
        return apiOk({ message: 'Collection cleared' });
      }

      default:
        return apiBadRequest(`Unknown action: ${action}`);
    }
  } catch (error: any) {
    return apiInternal(error.message);
  }
}
