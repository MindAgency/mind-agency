/**
 * GET /api/onboard — System onboarding status and next steps
 *
 * Provides a quick overview of what's configured and what needs setup:
 * - API key configured?
 * - WebSocket server running?
 * - Agents created?
 * - Groups created?
 * - Workflows created?
 * - Model configured?
 *
 * Based on UX best practices from Zapier, n8n, Make:
 * - Progressive disclosure: show only what matters right now
 * - Actionable next steps: tell users exactly what to do
 * - Clear severity: distinguish blocking vs optional issues
 * - Quick-start guidance: reduce time-to-value for new users
 * - Estimated setup time: set expectations for new users
 * - Provider-specific tips: help users get the most from their chosen provider
 * - Capability discovery: show what features unlock at each setup stage
 */

import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { AGENTS_DIR, GROUPS_DIR, MIND_DIR } from '@/lib/data-dir';
import { checkWsHealth } from '@/lib/ws-embedded';

export const dynamic = 'force-dynamic';

interface OnboardCheck {
  /** Unique check identifier */
  name: string;
  /** Check result: ready (good), partial (needs attention), missing (blocking) */
  status: 'ready' | 'missing' | 'partial';
  /** Human-readable status message */
  message: string;
  /** Suggested action to resolve the issue */
  action?: string;
  /** URL path to navigate to for this action */
  actionUrl?: string;
  /** Whether this is blocking overall setup */
  blocking: boolean;
  /** Priority order for display (lower = shown first) */
  sortOrder: number;
}

interface OnboardStep {
  label: string;
  description: string;
  completed: boolean;
  actionUrl?: string;
}

export async function GET() {
  const checks: OnboardCheck[] = [];
  const warnings: string[] = [];

  // ── 1. API Key (blocking) ──
  let hasApiKey = !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY);
  let apiKeySource = hasApiKey ? 'env' : '';
  let providerName = '';

  if (process.env.ANTHROPIC_API_KEY) providerName = 'Anthropic (Claude)';
  else if (process.env.OPENAI_API_KEY) providerName = 'OpenAI (GPT)';
  else if (process.env.DEEPSEEK_API_KEY) providerName = 'DeepSeek';

  if (!hasApiKey) {
    try {
      const settingsPath = path.join(MIND_DIR, 'settings.json');
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        if (settings.anthropicApiKey) { hasApiKey = true; apiKeySource = 'settings.json'; providerName = 'Anthropic (Claude)'; }
        else if (settings.openaiApiKey) { hasApiKey = true; apiKeySource = 'settings.json'; providerName = 'OpenAI (GPT)'; }
        else if (settings.deepseekApiKey) { hasApiKey = true; apiKeySource = 'settings.json'; providerName = 'DeepSeek'; }
        else if (settings.apiKey) { hasApiKey = true; apiKeySource = 'settings.json'; providerName = 'AI Provider'; }
      }
    } catch (e) { /* ignore */ }
  }

  checks.push({
    name: 'ai_provider',
    status: hasApiKey ? 'ready' : 'missing',
    message: hasApiKey
      ? `AI provider configured: ${providerName} (${apiKeySource === 'settings.json' ? 'Settings' : 'environment variable'})`
      : 'No AI provider API key found. You need at least one to use Mind Agency.',
    action: hasApiKey
      ? undefined
      : 'Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or DEEPSEEK_API_KEY in your .env file, or open Settings to add one.',
    actionUrl: hasApiKey ? undefined : '/settings',
    blocking: !hasApiKey,
    sortOrder: 0,
  });

  // ── 2. Model Configuration ──
  let modelConfigured = false;
  let currentModel = 'unknown';
  try {
    const settingsPath = path.join(MIND_DIR, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      currentModel = settings.model || 'default';
      modelConfigured = true;
    }
  } catch (e) { /* ignore */ }

  const modelTips: Record<string, string> = {
    'claude-sonnet': 'Good balance of speed and quality for most tasks.',
    'claude-opus': 'Best quality, slower — ideal for complex reasoning and reviews.',
    'claude-haiku': 'Fastest and cheapest — great for simple tasks and high-volume workflows.',
    'gpt-4o': 'Strong all-around model with good code and reasoning abilities.',
    'gpt-4o-mini': 'Fast and affordable — good for drafts and simple automation.',
    'deepseek-chat': 'Cost-effective with strong coding capabilities.',
  };
  const matchedTip = Object.entries(modelTips).find(([k]) => currentModel.toLowerCase().includes(k));

  checks.push({
    name: 'ai_model',
    status: modelConfigured ? 'ready' : 'partial',
    message: modelConfigured
      ? `Using model: ${currentModel}${matchedTip ? ` — ${matchedTip[1]}` : ''}`
      : 'No model selected. Using default — you can customize this in Settings.',
    action: modelConfigured ? undefined : 'Open Settings to choose a model.',
    actionUrl: '/settings',
    blocking: false,
    sortOrder: 1,
  });

  // ── 3. WebSocket Server ──
  const wsHealthy = await checkWsHealth();
  checks.push({
    name: 'websocket',
    status: wsHealthy ? 'ready' : 'missing',
    message: wsHealthy
      ? 'WebSocket server is running (port 3001) — real-time updates enabled'
      : 'WebSocket server is offline. Multi-agent features and real-time workflow updates require it.',
    action: wsHealthy ? undefined : 'Run: npm run dev:ws  (in a separate terminal)',
    actionUrl: undefined,
    blocking: !wsHealthy,
    sortOrder: 2,
  });

  // ── 4. Agents ──
  let agentCount = 0;
  let agentNames: string[] = [];
  try {
    if (fs.existsSync(AGENTS_DIR)) {
      const entries = fs.readdirSync(AGENTS_DIR, { withFileTypes: true });
      const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.'));
      agentCount = dirs.length;
      agentNames = dirs.slice(0, 5).map(e => e.name);
    }
  } catch (e) { /* ignore */ }

  checks.push({
    name: 'agents',
    status: agentCount > 0 ? 'ready' : 'missing',
    message: agentCount > 0
      ? `${agentCount} agent${agentCount === 1 ? '' : 's'} created${agentNames.length > 0 ? `: ${agentNames.join(', ')}${agentCount > 5 ? '...' : ''}` : ''}`
      : 'No agents yet. Create your first agent to start chatting and running workflows.',
    action: agentCount > 0 ? undefined : 'Create an agent from the sidebar — start with a "worker" agent for general tasks.',
    actionUrl: agentCount > 0 ? undefined : '/agents',
    blocking: agentCount === 0,
    sortOrder: 3,
  });

  // ── 5. Groups ──
  let groupCount = 0;
  let groupNames: string[] = [];
  try {
    if (fs.existsSync(GROUPS_DIR)) {
      const entries = fs.readdirSync(GROUPS_DIR, { withFileTypes: true });
      const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.'));
      groupCount = dirs.length;
      groupNames = dirs.slice(0, 5).map(e => e.name);
    }
  } catch (e) { /* ignore */ }

  checks.push({
    name: 'groups',
    status: groupCount > 0 ? 'ready' : 'partial',
    message: groupCount > 0
      ? `${groupCount} group${groupCount === 1 ? '' : 's'} created${groupNames.length > 0 ? `: ${groupNames.join(', ')}${groupCount > 5 ? '...' : ''}` : ''}`
      : 'No groups. Groups let agents collaborate on workflows together — optional but recommended.',
    action: groupCount > 0 ? undefined : 'Create a group from the sidebar to enable multi-agent workflows.',
    actionUrl: '/groups',
    blocking: false,
    sortOrder: 4,
  });

  // ── 6. Workflows ──
  let workflowCount = 0;
  let workflowNames: string[] = [];
  try {
    if (fs.existsSync(GROUPS_DIR)) {
      const groupDirs = fs.readdirSync(GROUPS_DIR, { withFileTypes: true }).filter(e => e.isDirectory());
      for (const g of groupDirs) {
        const wfDir = path.join(GROUPS_DIR, g.name, 'workflows');
        if (fs.existsSync(wfDir)) {
          const files = fs.readdirSync(wfDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml') || f.endsWith('.json'));
          workflowCount += files.length;
          workflowNames.push(...files.slice(0, 3).map(f => f.replace(/\.(yaml|yml|json)$/, '')));
        }
      }
    }
  } catch (e) { /* ignore */ }

  checks.push({
    name: 'workflows',
    status: workflowCount > 0 ? 'ready' : 'partial',
    message: workflowCount > 0
      ? `${workflowCount} workflow${workflowCount === 1 ? '' : 's'} found across all groups${workflowNames.length > 0 ? `: ${workflowNames.slice(0, 3).join(', ')}${workflowCount > 3 ? '...' : ''}` : ''}`
      : 'No workflows yet. Try a template to automate your first multi-agent task.',
    action: workflowCount > 0 ? undefined : 'Use a workflow template from the Workflow panel — "Quick Start" takes 30 seconds.',
    actionUrl: workflowCount > 0 ? undefined : '/workflows',
    blocking: false,
    sortOrder: 5,
  });

  // ── 7. Data Directory ──
  const mindDirExists = fs.existsSync(MIND_DIR);
  checks.push({
    name: 'data_dir',
    status: mindDirExists ? 'ready' : 'partial',
    message: mindDirExists
      ? '.mind directory exists — system is initialized'
      : '.mind directory will be created on first use',
    blocking: false,
    sortOrder: 6,
  });

  // ── Sort checks by priority ──
  checks.sort((a, b) => a.sortOrder - b.sortOrder);

  // ── Overall readiness ──
  const blockingChecks = checks.filter(c => c.blocking);
  const missingCount = checks.filter(c => c.status === 'missing').length;
  const readyCount = checks.filter(c => c.status === 'ready').length;
  const overallStatus = missingCount === 0 ? 'ready' : readyCount > 0 ? 'partial' : 'not_ready';

  // ── Contextual next steps (ordered, blocking first) ──
  const nextSteps: string[] = [];
  for (const check of checks) {
    if (check.status !== 'ready' && check.action) {
      nextSteps.push(check.action);
    }
  }

  // ── Onboarding checklist (progressive, like Zapier) ──
  const onboardingSteps: OnboardStep[] = [
    {
      label: 'Configure AI provider',
      description: hasApiKey ? 'Done' : 'Add an API key for Claude, OpenAI, or DeepSeek',
      completed: hasApiKey,
      actionUrl: hasApiKey ? undefined : '/settings',
    },
    {
      label: 'Create an agent',
      description: agentCount > 0 ? `${agentCount} agent${agentCount === 1 ? '' : 's'} created` : 'Set up your first AI agent',
      completed: agentCount > 0,
      actionUrl: agentCount > 0 ? undefined : '/agents',
    },
    {
      label: 'Start a conversation',
      description: 'Send a message to your agent to verify it works',
      completed: false, // Cannot detect this reliably; always show as next step
    },
    {
      label: 'Create a group (optional)',
      description: groupCount > 0 ? `${groupCount} group${groupCount === 1 ? '' : 's'} created` : 'Enable multi-agent collaboration',
      completed: groupCount > 0,
      actionUrl: groupCount > 0 ? undefined : '/groups',
    },
    {
      label: 'Run a workflow',
      description: workflowCount > 0 ? `${workflowCount} workflow${workflowCount === 1 ? '' : 's'} created` : 'Automate a multi-step task',
      completed: workflowCount > 0,
    },
  ];

  const completedSteps = onboardingSteps.filter(s => s.completed).length;
  const progressPercent = Math.round((completedSteps / onboardingSteps.length) * 100);

  // ── Quick-start messages by readiness ──
  let welcomeMessage: string;
  let primaryAction: string | undefined;
  let primaryActionUrl: string | undefined;

  if (overallStatus === 'ready') {
    welcomeMessage = 'Everything is configured. You are ready to go!';
    primaryAction = undefined;
    primaryActionUrl = undefined;
  } else if (blockingChecks.length > 0 && blockingChecks[0].name === 'ai_provider') {
    welcomeMessage = 'Welcome to Mind Agency! Let\'s get you set up in under a minute.';
    primaryAction = 'Configure AI provider';
    primaryActionUrl = '/settings';
  } else if (blockingChecks.length > 0 && blockingChecks[0].name === 'agents') {
    welcomeMessage = 'AI provider is ready. Now create your first agent to start using Mind Agency.';
    primaryAction = 'Create your first agent';
    primaryActionUrl = '/agents';
  } else if (blockingChecks.length > 0 && blockingChecks[0].name === 'websocket') {
    welcomeMessage = 'Almost there — start the WebSocket server to unlock multi-agent features.';
    primaryAction = 'Start WebSocket server';
    primaryActionUrl = undefined;
  } else {
    welcomeMessage = 'Mind Agency is partially configured. Complete the setup below.';
    primaryAction = nextSteps[0];
    primaryActionUrl = undefined;
  }

  // ── Estimated setup time (minutes) ──
  const setupStepsRemaining = blockingChecks.length + checks.filter(c => c.status === 'partial').length;
  const estimatedMinutes = Math.max(1, setupStepsRemaining * 2);

  // ── System health summary ──
  const systemHealth = {
    ready: readyCount,
    partial: checks.filter(c => c.status === 'partial').length,
    missing: missingCount,
    total: checks.length,
    score: Math.round((readyCount / checks.length) * 100),
  };

  // ── Capability discovery — what features unlock at each stage ──
  const capabilities: Array<{ name: string; enabled: boolean; requires: string }> = [
    { name: 'Single agent chat', enabled: hasApiKey && agentCount > 0, requires: 'AI provider + at least 1 agent' },
    { name: 'Multi-agent workflows', enabled: hasApiKey && agentCount > 0 && groupCount > 0, requires: 'AI provider + agents + a group' },
    { name: 'Real-time workflow updates', enabled: wsHealthy, requires: 'WebSocket server running' },
    { name: 'Automated reviews', enabled: agentCount >= 2, requires: 'At least 2 agents (worker + reviewer)' },
    { name: 'Research pipelines', enabled: hasApiKey && agentCount >= 2 && groupCount > 0, requires: 'AI provider + 2+ agents + a group' },
  ];

  // ── Provider-specific tips ──
  const providerTips: string[] = [];
  if (providerName.includes('Anthropic')) {
    providerTips.push('Claude Opus is great for complex reviews; use Haiku for cost-effective batch tasks.');
  } else if (providerName.includes('OpenAI')) {
    providerTips.push('GPT-4o excels at code; GPT-4o-mini is cost-effective for high-volume workflows.');
  } else if (providerName.includes('DeepSeek')) {
    providerTips.push('DeepSeek is very cost-effective — ideal for running many workflow steps.');
  }

  return NextResponse.json({
    status: overallStatus,
    timestamp: new Date().toISOString(),
    checks,
    nextSteps,
    warnings,
    onboarding: {
      steps: onboardingSteps,
      completed: completedSteps,
      total: onboardingSteps.length,
      progressPercent,
    },
    welcome: {
      message: welcomeMessage,
      primaryAction,
      primaryActionUrl,
    },
    systemHealth,
    estimatedSetupTime: setupStepsRemaining > 0 ? `~${estimatedMinutes} min` : 'Ready',
    capabilities,
    providerTips,
    quickStart: [
      '1. Set your API key in Settings (if not done)',
      '2. Create an agent from the sidebar',
      '3. Chat with your agent to verify it works',
      '4. Create a group for multi-agent collaboration',
      '5. Try a workflow template to automate tasks',
    ],
  });
}
