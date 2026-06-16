/**
 * Workflow Templates — Pre-built templates for common use cases
 *
 * Each template is a function that returns a WorkflowDefinition.
 * Templates can be customized by passing parameters.
 *
 * Design principles (from Zapier/n8n/Make best practices):
 * - Quick Start: minimal 1-step template for instant time-to-value
 * - Clear descriptions: explain what the workflow does in plain language
 * - Progressive complexity: simple templates first, complex ones later
 * - Meaningful defaults: most fields have sensible defaults so users can
 *   create a workflow by filling in only 1-2 required fields
 * - Difficulty indicators: help users choose templates matching their comfort level
 * - Estimated time: set expectations for how long the workflow takes to complete
 */

import type { WorkflowDefinition, WorkflowStep } from './workflow/types';

// ═══════════════════════════════════════════════════ Types ═══

export interface TemplateParam {
  /** Parameter key */
  key: string;
  /** Display name */
  label: string;
  /** Description */
  description?: string;
  /** Default value */
  default?: string;
  /** Whether required */
  required?: boolean;
}

export interface WorkflowTemplate {
  /** Unique template identifier */
  id: string;
  /** Display name */
  name: string;
  /** Description */
  description: string;
  /** Category for grouping */
  category: 'teaching' | 'research' | 'development' | 'business' | 'general';
  /** Icon (emoji or icon name) */
  icon: string;
  /** Difficulty level for non-technical users */
  difficulty: 'easy' | 'medium' | 'advanced';
  /** Estimated time for the workflow to complete */
  estimatedTime: string;
  /** Number of agents required minimum */
  requiredAgents: number;
  /** Parameters that can be customized */
  params: TemplateParam[];
  /** Generate workflow definition from params */
  generate: (params: Record<string, string>) => WorkflowDefinition;
}

// ═══════════════════════════════════════════════════ Templates ═══

/** Quick Start: single-step task — the simplest possible workflow */
const quickStartTemplate: WorkflowTemplate = {
  id: 'quick-start',
  name: 'Quick Start',
  description: 'Run a single task with one agent. The fastest way to see workflows in action — takes 30 seconds to set up.',
  category: 'general',
  icon: '🚀',
  difficulty: 'easy',
  estimatedTime: '30s',
  requiredAgents: 1,
  params: [
    { key: 'task', label: 'Task', description: 'What should the agent do? (e.g., "Summarize this article", "Write a haiku")', required: true },
    { key: 'agent', label: 'Agent', description: 'Which agent should run this task', default: 'worker' },
  ],
  generate: (params) => ({
    name: `quick-${(params.task || 'task').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}`,
    description: params.task || 'Quick task',
    steps: [
      {
        id: 'run_task',
        type: 'step',
        agent: params.agent || 'worker',
        action: 'execute',
        prompt: params.task,
        priority: 'high',
        reward: 5,
      },
    ],
  }),
};

/** Teaching: Lesson plan → review → quiz generation */
const teachingTemplate: WorkflowTemplate = {
  id: 'teaching-pipeline',
  name: 'Teaching Pipeline',
  description: 'Three-step pipeline: create a lesson plan, have a reviewer check it, then auto-generate a quiz. Good for creating course materials.',
  category: 'teaching',
  icon: '📚',
  difficulty: 'medium',
  estimatedTime: '3-5 min',
  requiredAgents: 3,
  params: [
    { key: 'topic', label: 'Topic', description: 'What to teach', required: true },
    { key: 'level', label: 'Level', description: 'Student level (beginner/intermediate/advanced)', default: 'beginner' },
    { key: 'reviewer', label: 'Reviewer Agent', description: 'Agent to review the lesson', default: 'reviewer' },
    { key: 'quizAgent', label: 'Quiz Creator Agent', description: 'Agent to create quiz questions', default: 'quiz-maker' },
  ],
  generate: (params) => ({
    name: `teaching-${(params.topic || 'general').toLowerCase().replace(/\s+/g, '-')}`,
    description: `Teaching pipeline for: ${params.topic}`,
    steps: [
      {
        id: 'create_lesson',
        type: 'step',
        agent: 'teacher',
        action: 'create',
        prompt: `Create a comprehensive lesson plan about "${params.topic}" for ${params.level || 'beginner'} students.\n\nInclude:\n1. Learning objectives\n2. Key concepts and explanations\n3. Examples\n4. Practice exercises\n\nFormat as a structured document with clear sections.`,
        priority: 'high',
        reward: 10,
      },
      {
        id: 'review_lesson',
        type: 'step',
        agent: params.reviewer || 'reviewer',
        action: 'review',
        prompt: `Review the lesson plan about "${params.topic}".\n\nCheck for:\n1. Accuracy of information\n2. Completeness of coverage\n3. Appropriate difficulty level\n4. Clear explanations\n\nProvide specific feedback and approve or reject with reasons.`,
        dependsOn: ['create_lesson'],
        reviewer: params.reviewer || 'reviewer',
        onReject: 'fail',
        priority: 'high',
      },
      {
        id: 'generate_quiz',
        type: 'step',
        agent: params.quizAgent || 'quiz-maker',
        action: 'create',
        prompt: `Based on the lesson plan about "${params.topic}", create a quiz to test understanding.\n\nInclude:\n1. 5 multiple choice questions\n2. 2 short answer questions\n3. 1 essay question\n4. Answer key\n\nMake questions progressively harder.`,
        dependsOn: ['review_lesson'],
        priority: 'normal',
        reward: 5,
      },
    ],
  }),
};

/** Research: Literature review → analysis → paper writing */
const researchTemplate: WorkflowTemplate = {
  id: 'research-pipeline',
  name: 'Research Pipeline',
  description: 'Three-step research pipeline: gather sources, analyze themes, then write a structured summary. Ideal for literature reviews or topic deep-dives.',
  category: 'research',
  icon: '🔬',
  difficulty: 'medium',
  estimatedTime: '5-8 min',
  requiredAgents: 3,
  params: [
    { key: 'topic', label: 'Research Topic', required: true },
    { key: 'scope', label: 'Scope', description: 'Narrow or broad review', default: 'broad' },
    { key: 'analyst', label: 'Analyst Agent', default: 'analyst' },
    { key: 'writer', label: 'Writer Agent', default: 'writer' },
  ],
  generate: (params) => ({
    name: `research-${(params.topic || 'general').toLowerCase().replace(/\s+/g, '-')}`,
    description: `Research pipeline for: ${params.topic}`,
    steps: [
      {
        id: 'literature_review',
        type: 'step',
        agent: 'researcher',
        action: 'research',
        prompt: `Conduct a ${params.scope || 'broad'} literature review on "${params.topic}".\n\nFind and summarize:\n1. Key papers and publications\n2. Main findings and theories\n3. Research gaps\n4. Current trends\n\nCite sources appropriately.`,
        priority: 'high',
        reward: 15,
      },
      {
        id: 'analysis',
        type: 'step',
        agent: params.analyst || 'analyst',
        action: 'execute',
        prompt: `Analyze the literature review findings on "${params.topic}".\n\nProvide:\n1. Thematic analysis\n2. Comparison of approaches\n3. Strengths and weaknesses\n4. Research implications\n\nBe critical and analytical.`,
        dependsOn: ['literature_review'],
        priority: 'high',
        reward: 10,
      },
      {
        id: 'write_summary',
        type: 'step',
        agent: params.writer || 'writer',
        action: 'create',
        prompt: `Write a research summary paper on "${params.topic}" based on the analysis.\n\nInclude:\n1. Abstract\n2. Introduction\n3. Methodology (if applicable)\n4. Findings\n5. Discussion\n6. Conclusion\n7. References\n\nUse academic writing style.`,
        dependsOn: ['analysis'],
        priority: 'normal',
        reward: 20,
      },
    ],
  }),
};

/** Development: Code → review → test */
const developmentTemplate: WorkflowTemplate = {
  id: 'dev-pipeline',
  name: 'Development Pipeline',
  description: 'Three-step dev pipeline: implement a feature, get a code review, then auto-generate tests. Mirrors a standard PR workflow.',
  category: 'development',
  icon: '💻',
  difficulty: 'medium',
  estimatedTime: '5-10 min',
  requiredAgents: 3,
  params: [
    { key: 'task', label: 'Coding Task', description: 'What to implement', required: true },
    { key: 'language', label: 'Language', description: 'Programming language', default: 'TypeScript' },
    { key: 'coder', label: 'Coder Agent', default: 'coder' },
    { key: 'reviewer', label: 'Reviewer Agent', default: 'code-reviewer' },
    { key: 'tester', label: 'Tester Agent', default: 'tester' },
  ],
  generate: (params) => ({
    name: `dev-${(params.task || 'feature').toLowerCase().replace(/\s+/g, '-')}`,
    description: `Development pipeline for: ${params.task}`,
    steps: [
      {
        id: 'implement',
        type: 'step',
        agent: params.coder || 'coder',
        action: 'create',
        prompt: `Implement the following in ${params.language || 'TypeScript'}:\n\n${params.task}\n\nRequirements:\n1. Clean, readable code\n2. Proper error handling\n3. Type safety\n4. Comments for complex logic\n\nWrite the implementation to a file.`,
        priority: 'high',
        reward: 10,
      },
      {
        id: 'code_review',
        type: 'step',
        agent: params.reviewer || 'code-reviewer',
        action: 'review',
        prompt: `Review the code implementation for "${params.task}".\n\nCheck for:\n1. Code quality and readability\n2. Error handling\n3. Performance\n4. Security concerns\n5. Best practices\n\nProvide specific feedback with line numbers if possible.`,
        dependsOn: ['implement'],
        reviewer: params.reviewer || 'code-reviewer',
        onReject: 'fail',
        priority: 'high',
      },
      {
        id: 'write_tests',
        type: 'step',
        agent: params.tester || 'tester',
        action: 'create',
        prompt: `Write comprehensive tests for "${params.task}".\n\nInclude:\n1. Unit tests for core functions\n2. Edge case tests\n3. Error handling tests\n4. Integration tests (if applicable)\n\nUse appropriate testing framework.`,
        dependsOn: ['code_review'],
        priority: 'normal',
        reward: 8,
      },
    ],
  }),
};

/** Business: Email drafting → review → send */
const businessTemplate: WorkflowTemplate = {
  id: 'business-pipeline',
  name: 'Business Communication',
  description: 'Three-step communication pipeline: draft a professional email, review for tone and clarity, then finalize for sending.',
  category: 'business',
  icon: '💼',
  difficulty: 'easy',
  estimatedTime: '2-3 min',
  requiredAgents: 2,
  params: [
    { key: 'recipient', label: 'Recipient', description: 'Who the email is for', required: true },
    { key: 'purpose', label: 'Purpose', description: 'What the email is about', required: true },
    { key: 'tone', label: 'Tone', description: 'Professional/casual/friendly', default: 'professional' },
    { key: 'draftsman', label: 'Drafting Agent', default: 'writer' },
    { key: 'reviewer', label: 'Reviewer Agent', default: 'reviewer' },
  ],
  generate: (params) => ({
    name: `email-${(params.recipient || 'recipient').toLowerCase().replace(/\s+/g, '-')}`,
    description: `Email pipeline for: ${params.purpose}`,
    steps: [
      {
        id: 'draft_email',
        type: 'step',
        agent: params.draftsman || 'writer',
        action: 'create',
        prompt: `Draft a ${params.tone || 'professional'} email to ${params.recipient}.\n\nPurpose: ${params.purpose}\n\nInclude:\n1. Clear subject line\n2. Professional greeting\n3. Concise body with key points\n4. Call to action\n5. Professional closing\n\nMake it ready to send.`,
        priority: 'high',
        reward: 5,
      },
      {
        id: 'review_email',
        type: 'step',
        agent: params.reviewer || 'reviewer',
        action: 'review',
        prompt: `Review the draft email for ${params.recipient}.\n\nCheck for:\n1. Professional tone\n2. Clarity and conciseness\n3. Grammar and spelling\n4. Appropriate formality\n5. Effective communication\n\nSuggest improvements and approve or reject.`,
        dependsOn: ['draft_email'],
        reviewer: params.reviewer || 'reviewer',
        onReject: 'retry',
        maxRejectRetries: 2,
        priority: 'high',
      },
      {
        id: 'finalize',
        type: 'step',
        agent: params.draftsman || 'writer',
        action: 'execute',
        prompt: `Finalize the email based on the review feedback.\n\nIncorporate all suggested improvements while maintaining the original message.\n\nOutput the final, ready-to-send email with subject line.`,
        dependsOn: ['review_email'],
        priority: 'normal',
      },
    ],
  }),
};

/** General: Simple task → review → completion */
const generalTemplate: WorkflowTemplate = {
  id: 'general-pipeline',
  name: 'General Task Pipeline',
  description: 'Two-step general pipeline: execute any task, then have a reviewer verify the result. Good for tasks that need a quality check.',
  category: 'general',
  icon: '⚡',
  difficulty: 'easy',
  estimatedTime: '2-4 min',
  requiredAgents: 2,
  params: [
    { key: 'task', label: 'Task Description', required: true },
    { key: 'worker', label: 'Worker Agent', default: 'worker' },
    { key: 'reviewer', label: 'Reviewer Agent', default: 'reviewer' },
  ],
  generate: (params) => ({
    name: `task-${Date.now().toString(36)}`,
    description: `General pipeline for: ${params.task}`,
    steps: [
      {
        id: 'execute_task',
        type: 'step',
        agent: params.worker || 'worker',
        action: 'execute',
        prompt: `Complete the following task:\n\n${params.task}\n\nProvide a detailed output with all relevant information.`,
        priority: 'high',
        reward: 10,
      },
      {
        id: 'review_task',
        type: 'step',
        agent: params.reviewer || 'reviewer',
        action: 'review',
        prompt: `Review the task completion.\n\nCheck if the task was completed correctly and completely.\n\nProvide feedback and approve or reject.`,
        dependsOn: ['execute_task'],
        reviewer: params.reviewer || 'reviewer',
        onReject: 'retry',
        maxRejectRetries: 1,
        priority: 'normal',
      },
    ],
  }),
};

// ═══════════════════════════════════════════════════ Registry ═══

/** Summarize Document: Quick-start 1-step template for summarizing content */
const summarizeTemplate: WorkflowTemplate = {
  id: 'summarize',
  name: 'Summarize Document',
  description: 'Summarize any text or document into key points. Quick and easy — just paste your content and get a structured summary.',
  category: 'general',
  icon: '📝',
  difficulty: 'easy',
  estimatedTime: '30s',
  requiredAgents: 1,
  params: [
    { key: 'content', label: 'Content to summarize', description: 'Paste the text, article, or document content here', required: true },
    { key: 'format', label: 'Output format', description: 'How to format the summary (bullets, paragraph, numbered list)', default: 'bullets' },
    { key: 'agent', label: 'Agent', description: 'Which agent should do the summarization', default: 'worker' },
  ],
  generate: (params) => ({
    name: `summarize-${Date.now().toString(36)}`,
    description: `Summarize: ${(params.content || '').slice(0, 50)}...`,
    steps: [
      {
        id: 'summarize',
        type: 'step',
        agent: params.agent || 'worker',
        action: 'execute',
        prompt: `Summarize the following content into ${params.format || 'bullets'} format.\n\nFocus on:\n1. Main ideas\n2. Key facts and data points\n3. Important conclusions\n\nContent:\n${params.content}\n\nProvide a clear, concise summary.`,
        priority: 'high',
        reward: 5,
      },
    ],
  }),
};

/** Code Review: 2-step pipeline — implement then review */
const codeReviewTemplate: WorkflowTemplate = {
  id: 'code-review',
  name: 'Code Review',
  description: 'Write code and get it reviewed by another agent. A simple two-step pipeline that catches issues before you ship.',
  category: 'development',
  icon: '🔍',
  difficulty: 'easy',
  estimatedTime: '2-3 min',
  requiredAgents: 2,
  params: [
    { key: 'task', label: 'What to implement', description: 'Describe the code you want written', required: true },
    { key: 'language', label: 'Language', description: 'Programming language (TypeScript, Python, etc.)', default: 'TypeScript' },
    { key: 'coder', label: 'Coder Agent', default: 'worker' },
    { key: 'reviewer', label: 'Reviewer Agent', default: 'reviewer' },
  ],
  generate: (params) => ({
    name: `review-${(params.task || 'code').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}`,
    description: `Code review for: ${params.task}`,
    steps: [
      {
        id: 'implement',
        type: 'step',
        agent: params.coder || 'worker',
        action: 'create',
        prompt: `Implement the following in ${params.language || 'TypeScript'}:\n\n${params.task}\n\nWrite clean, well-documented code with proper error handling.`,
        priority: 'high',
        reward: 8,
      },
      {
        id: 'review',
        type: 'step',
        agent: params.reviewer || 'reviewer',
        action: 'review',
        prompt: `Review the ${params.language || 'TypeScript'} code implementation.\n\nCheck for:\n1. Code quality and readability\n2. Error handling\n3. Performance\n4. Best practices\n\nProvide specific, actionable feedback.`,
        dependsOn: ['implement'],
        reviewer: params.reviewer || 'reviewer',
        onReject: 'retry',
        maxRejectRetries: 1,
        priority: 'high',
      },
    ],
  }),
};

const TEMPLATES: WorkflowTemplate[] = [
  quickStartTemplate,
  summarizeTemplate,
  codeReviewTemplate,
  generalTemplate,
  teachingTemplate,
  researchTemplate,
  developmentTemplate,
  businessTemplate,
];

/**
 * Get all available workflow templates
 */
export function getWorkflowTemplates(): WorkflowTemplate[] {
  return [...TEMPLATES];
}

/**
 * Get a template by ID
 */
export function getWorkflowTemplate(id: string): WorkflowTemplate | undefined {
  return TEMPLATES.find(t => t.id === id);
}

/**
 * Get templates by category
 */
export function getTemplatesByCategory(category: WorkflowTemplate['category']): WorkflowTemplate[] {
  return TEMPLATES.filter(t => t.category === category);
}

/**
 * Get templates by difficulty level
 */
export function getTemplatesByDifficulty(difficulty: WorkflowTemplate['difficulty']): WorkflowTemplate[] {
  return TEMPLATES.filter(t => t.difficulty === difficulty);
}

/**
 * Get recommended templates for a new user (easy difficulty, few agents needed)
 */
export function getRecommendedTemplates(agentCount: number): WorkflowTemplate[] {
  return TEMPLATES.filter(t => t.difficulty === 'easy' && t.requiredAgents <= Math.max(agentCount, 1));
}

/**
 * Generate a workflow definition from a template with custom parameters
 */
export function generateFromTemplate(
  templateId: string,
  params: Record<string, string> = {}
): WorkflowDefinition {
  const template = TEMPLATES.find(t => t.id === templateId);
  if (!template) {
    throw new Error(`Template "${templateId}" not found. Available: ${TEMPLATES.map(t => t.id).join(', ')}`);
  }

  // Merge with defaults
  const mergedParams: Record<string, string> = {};
  for (const p of template.params) {
    mergedParams[p.key] = params[p.key] || p.default || '';
    if (p.required && !mergedParams[p.key]) {
      throw new Error(`Template "${templateId}" requires parameter "${p.key}" (${p.label})`);
    }
  }

  return template.generate(mergedParams);
}

/**
 * Get template categories with counts
 */
export function getTemplateCategories(): Array<{ category: string; count: number; icon: string }> {
  const categories = new Map<string, { count: number; icon: string }>();
  for (const t of TEMPLATES) {
    const existing = categories.get(t.category);
    if (existing) {
      existing.count++;
    } else {
      categories.set(t.category, { count: 1, icon: t.icon });
    }
  }
  return Array.from(categories.entries()).map(([category, { count, icon }]) => ({
    category, count, icon,
  }));
}
