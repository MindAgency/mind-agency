/**
 * Skills API — List, search, install, uninstall, enable/disable
 *
 * GET    /api/system/skills              — list installed skills
 * POST   /api/system/skills              — install skill from GitHub
 * DELETE /api/system/skills?id=xxx       — uninstall skill
 * PUT    /api/system/skills              — enable/disable skill for agent
 */

import { NextRequest } from 'next/server';
import {
  getInstalledSkills,
  installSkill,
  uninstallSkill,
  searchSkills,
  enableSkill,
  disableSkill,
  getEnabledSkills,
  setEnabledSkills,
  isSkillEnabled,
} from '@/lib/skills';
import { apiOk, apiNotFound, apiBadRequest, apiCreated } from '@/lib/api-utils';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');
  const agent = searchParams.get('agent');

  // Search mode
  if (query) {
    const results = await searchSkills(query);
    return apiOk({ results });
  }

  // List installed with agent enable status
  const skills = getInstalledSkills();
  if (agent) {
    const enabledSkills = getEnabledSkills(agent);
    const skillsWithStatus = skills.map(s => ({
      ...s,
      enabled: enabledSkills.includes(s.name),
    }));
    return apiOk({ skills: skillsWithStatus });
  }

  return apiOk({ skills });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { repo, path: repoPath, agent, skillName, action } = body;

  // Enable/disable skill for agent
  if (action === 'enable' && agent && skillName) {
    const ok = enableSkill(agent, skillName);
    return apiOk({ success: ok });
  }

  if (action === 'disable' && agent && skillName) {
    const ok = disableSkill(agent, skillName);
    return apiOk({ success: ok });
  }

  if (action === 'set_enabled' && agent && Array.isArray(body.skillNames)) {
    setEnabledSkills(agent, body.skillNames);
    return apiOk();
  }

  // Install skill from GitHub
  if (!repo) {
    return apiBadRequest('repo required (e.g. "owner/repo")');
  }

  try {
    const skill = await installSkill(repo, repoPath);
    return apiCreated({ skill } as Record<string, unknown>);
  } catch (e: any) {
    return apiBadRequest(e.message);
  }
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id) return apiBadRequest('id required');

  const ok = uninstallSkill(id);
  if (!ok) return apiNotFound('Skill not found');
  return apiOk();
}
