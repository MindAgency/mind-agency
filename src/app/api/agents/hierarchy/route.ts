import { NextRequest, NextResponse } from 'next/server';
import {
  discoverAgentHierarchy,
  loadAgentHierarchy,
  routeGoalToAgents,
  saveAgentHierarchy,
  upsertHierarchyNode,
} from '@/lib/agent-hierarchy';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const discover = searchParams.get('discover') === 'true';
  const goal = searchParams.get('goal');

  if (goal) {
    return NextResponse.json({ decision: routeGoalToAgents(goal) });
  }

  const nodes = discover ? discoverAgentHierarchy() : loadAgentHierarchy();
  return NextResponse.json({ nodes });
}

export async function POST(request: NextRequest) {
  const body = await request.json();

  if (body.action === 'route') {
    if (!body.goal) return NextResponse.json({ error: 'goal required' }, { status: 400 });
    return NextResponse.json({
      decision: routeGoalToAgents(body.goal, {
        coordinator: body.coordinator,
        maxDelegates: body.maxDelegates,
      }),
    });
  }

  if (body.action === 'save' && Array.isArray(body.nodes)) {
    saveAgentHierarchy(body.nodes);
    return NextResponse.json({ success: true, nodes: body.nodes });
  }

  if (body.action === 'upsert' && body.node) {
    const nodes = upsertHierarchyNode(body.node);
    return NextResponse.json({ success: true, nodes });
  }

  return NextResponse.json({ error: 'unsupported action' }, { status: 400 });
}
