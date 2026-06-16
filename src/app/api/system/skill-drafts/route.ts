import { NextRequest, NextResponse } from 'next/server';
import { analyzeSessionToDraft, createSkillDraft, listSkillDrafts, publishSkillDraft } from '@/lib/skill-authoring';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ drafts: listSkillDrafts() });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (body.action === 'analyze') {
      if (!body.agent) return NextResponse.json({ error: 'agent required' }, { status: 400 });
      return NextResponse.json({ draft: analyzeSessionToDraft(body.agent, body.name) }, { status: 201 });
    }
    if (body.action === 'publish') {
      if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 });
      const draft = publishSkillDraft(body.id, { enableForAgent: body.enableForAgent });
      if (!draft) return NextResponse.json({ error: 'draft not found' }, { status: 404 });
      return NextResponse.json({ draft });
    }
    if (!body.agent || !body.name || !body.content) {
      return NextResponse.json({ error: 'agent, name, and content required' }, { status: 400 });
    }
    const draft = createSkillDraft({
      agent: body.agent,
      name: body.name,
      description: body.description || body.name,
      triggers: body.triggers || [],
      content: body.content,
      source: 'manual',
    });
    return NextResponse.json({ draft }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
