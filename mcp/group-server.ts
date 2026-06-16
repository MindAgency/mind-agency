#!/usr/bin/env node
/**
 * Group MCP Server for Mind Agency
 * One instance shared across all agents (agent name passed as CLI arg)
 *
 * Tools:
 *   group_list  — list groups the agent belongs to
 *   group_send  — post to Groups/<group>/chat/YYYY-MM-DD.md
 *   group_read  — read recent chat from date-named .md files
 *   group_join  — create Agents/<name>/email/
 *   group_leave — delete Agents/<name>/ directory
 */
import { createInterface } from 'readline';
import fs from 'fs';
import path from 'path';
import { writeAudit, checkPermission } from '../src/lib/audit.js';
import { writeMemory, readMemory, searchMemory, listMemory, deleteMemory } from '../src/lib/memory.js';
import { ensureGroupConfig, loadGroupConfig, saveGroupConfig, isGroupAdmin, isGroupOwner, addMember, kickMember, getGroupInfo, setGroupInfo, setGroupAnnouncement, removeGroupAnnouncement, setMemberRole } from '../src/lib/group-config.js';
import { submitDecision, listPendingRequests } from '../src/lib/consensus.js';
import { checkToolPermission } from '../src/lib/permission-engine.js';
import { randomUUID } from 'crypto';

// v0.4: Import shared utilities from tools/shared.ts
import {
  WS_BASE_URL, WS_BROADCAST_URL, WS_EVENTS_URL, API_BASE_URL, PROJECT_ROOT,
  groupsDir, exists, readDir, getAgentGroups,
  httpPost, fetchJSON, triggerPoll, broadcast, emitBusEvent,
  readGroupChat, appendToChat,
} from './tools/shared.js';

// v0.4: Import modular tool handlers
import { groupTools, handleGroupTool } from './tools/group.js';
import { communicationTools, handleCommunicationTool } from './tools/communication.js';
import { workflowTools, handleWorkflowTool } from './tools/workflow.js';
import { agentTools, handleAgentTool } from './tools/agent.js';
import { consensusTools, handleConsensusTool } from './tools/consensus.js';
import { memoryTools, handleMemoryTool } from './tools/memory.js';
import { taskTools, handleTaskTool } from './tools/task.js';
import { economyTools, handleEconomyTool } from './tools/economy.js';
import { searchTools, handleSearchTool } from './tools/search.js';
import { hierarchyTools, handleHierarchyTool } from './tools/hierarchy.js';
import { managedTools, handleManagedTool } from './tools/managed.js';

let agentName = '';

// v0.4: Combine tool definitions from modules
const tools = [
  ...groupTools(),
  ...communicationTools(),
  ...workflowTools(),
  ...agentTools(),
  ...consensusTools(),
  ...memoryTools(),
  ...taskTools(),
  ...economyTools(),
  ...searchTools(),
  ...hierarchyTools(),
  ...managedTools(),
];

const rl = createInterface({ input: process.stdin });

rl.on('line', async (line: string) => {
  if (!line.trim()) return;
  let req: any;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;

  try {
    if (method === 'initialize') { respond(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mind-agency-group-mcp', version: '1.0.0' } }); return; }
    if (method === 'notifications/initialized') return;
    if (method === 'tools/list') { respond(id, { tools }); return; }

    if (method === 'tools/call') {
      const name = params?.name;
      const a = params?.arguments || {};

      // ── Input validation (before permission check) ──
      if (name === 'agent_create') {
        const newName = (a.name || '').trim();
        if (!newName || !/^[a-zA-Z0-9_-]+$/.test(newName) || newName.length > 50) {
          respond(id, { content: [{ type: 'text', text: 'Invalid agent name: only alphanumeric, underscore, hyphen allowed (max 50 chars)' }], isError: true });
          return;
        }
        // Block path traversal
        if (newName.includes('/') || newName.includes('\\') || newName.includes('..')) {
          respond(id, { content: [{ type: 'text', text: 'Invalid agent name: path traversal not allowed' }], isError: true });
          return;
        }
      }
      // Validate group names for path traversal
      if (a.group) {
        const g = (a.group || '').trim();
        if (g.includes('/') || g.includes('\\') || g.includes('..') || g.length > 50) {
          respond(id, { content: [{ type: 'text', text: 'Invalid group name' }], isError: true });
          return;
        }
      }

      // ── Unified permission check ──
      const perm = checkToolPermission(agentName, name, a);
      if (!perm.allowed) {
        respond(id, { content: [{ type: 'text', text: perm.message }], isError: true });
        return;
      }

      // v0.4: Try modular handlers first — return true if handled.
      const modHandlers = [handleGroupTool, handleCommunicationTool, handleWorkflowTool, handleAgentTool, handleConsensusTool, handleMemoryTool, handleTaskTool, handleEconomyTool, handleSearchTool, handleHierarchyTool, handleManagedTool];
      for (const handler of modHandlers) {
        try {
          if (await handler(name, a, agentName, respond, id)) return;
        } catch (e) {
          console.error(`[mcp] handler error for ${name}:`, e);
        }
      }

      // ──────────────────────────────────────────────────────────────────────
      // INLINE TOOL HANDLERS (legacy fallback)
      //
      // The modular handlers above (imported from ./tools/*.ts) are the
      // canonical implementations and are tried FIRST. The inline code below
      // duplicates their logic and serves only as a fallback in case a tool
      // is not yet ported to the modular system or a module import fails.
      //
      // DO NOT add new tool logic here — add it in the corresponding
      // ./tools/ module instead. This section should shrink over time as
      // all tools are migrated.
      // ──────────────────────────────────────────────────────────────────────

      if (name === 'group_list') {
        const groups = getAgentGroups(agentName);
        const result = groups.map(g => {
          const agDir = path.join(groupsDir(), g, 'Agents');
          const members = exists(agDir) ? readDir(agDir).filter(e => e.isDirectory()).map(e => e.name) : [];
          const lastMsg = readGroupChat(g, 1)[0];
          return { group: g, members, groupEmail: `Groups/${g}/Agents/${agentName}/email/`, lastMessage: lastMsg ? `${lastMsg.from}: ${lastMsg.body.slice(0, 60)}` : null };
        });
        respond(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
        return;
      }

      if (name === 'group_send') {
        const { group, message } = a;
        if (!group || !message) { respond(id, { content: [{ type: 'text', text: 'group and message required' }], isError: true }); return; }
        if (!getAgentGroups(agentName).includes(group)) { respond(id, { content: [{ type: 'text', text: `you are not a member of ${group}` }], isError: true }); return; }
        appendToChat(group, agentName, message);
        broadcast({ type: 'group_message', group, from: agentName, message });
        triggerPoll(agentName, group); // v0.4: 定向触发，不等轮询
        writeAudit({ agent: agentName, action: 'group.send', resource: `group:${group}`, details: message.slice(0, 200) });
        // ── EventBus: message.sent ──
        const mentions = (message.match(/@([^\s]+)/g) || []).map((m: string) => m.slice(1));
        emitBusEvent('message.sent', {
          sender: agentName,
          group,
          mentions,
          length: message.length, // UTF-16 字符数
        }, agentName);

        // ── EventBus: message.mention (if mentions present) ──
        if (mentions.length > 0) {
          emitBusEvent('message.mention', {
            sender: agentName,
            group,
            mentioned: mentions,
          }, agentName);
        }

        respond(id, { content: [{ type: 'text', text: `sent to ${group}` }] });
        return;
      }

      if (name === 'group_read') {
        const { group, limit } = a;
        if (!group) { respond(id, { content: [{ type: 'text', text: 'group required' }], isError: true }); return; }
        if (!getAgentGroups(agentName).includes(group)) { respond(id, { content: [{ type: 'text', text: `you are not a member of ${group}` }], isError: true }); return; }
        const msgs = readGroupChat(group, limit || 20);
        respond(id, { content: [{ type: 'text', text: msgs.length ? JSON.stringify(msgs, null, 2) : `${group} has no messages` }] });
        return;
      }

      if (name === 'group_join') {
        const { group } = a;
        if (!group) { respond(id, { content: [{ type: 'text', text: 'group required' }], isError: true }); return; }
        const gDir = path.join(groupsDir(), group);
        if (!exists(gDir)) { respond(id, { content: [{ type: 'text', text: `group "${group}" not found` }], isError: true }); return; }
        const agDir = path.join(gDir, 'Agents', agentName);
        if (exists(agDir)) { respond(id, { content: [{ type: 'text', text: `already in ${group}` }] }); return; }

        // Require invitation unless inviter is group admin or this is a new group with no members
        const invDir = path.join(gDir, '.invitations');
        const invFile = path.join(invDir, `${agentName.toLowerCase()}.json`);
        const wasInvited = exists(invFile);

        if (!wasInvited) {
          // Allow join without invitation only if group has no members yet (brand new group)
          const membersDir = path.join(gDir, 'Agents');
          const hasMembers = exists(membersDir) && readDir(membersDir).filter(e => e.isDirectory()).length > 0;
          if (hasMembers) {
            respond(id, { content: [{ type: 'text', text: `cannot join ${group}: you need an invitation from a group admin` }], isError: true });
            return;
          }
        }

        if (wasInvited) { try { fs.unlinkSync(invFile); } catch {} }
        fs.mkdirSync(path.join(agDir, 'email'), { recursive: true });
        appendToChat(group, 'system', `${agentName} ${wasInvited ? '接受了邀请并' : ''}加入了群组`);
        writeAudit({ agent: agentName, action: 'group.join', resource: `group:${group}`, details: wasInvited ? 'accepted invitation' : 'joined directly' });
        triggerPoll(agentName, group);
        respond(id, { content: [{ type: 'text', text: `joined ${group}${wasInvited ? ' (accepted invitation)' : ''}` }] });
        return;
      }

      if (name === 'group_leave') {
        const { group } = a;
        if (!group) { respond(id, { content: [{ type: 'text', text: 'group required' }], isError: true }); return; }
        const agDir = path.join(groupsDir(), group, 'Agents', agentName);
        if (!exists(agDir)) { respond(id, { content: [{ type: 'text', text: `not in ${group}` }] }); return; }
        appendToChat(group, 'system', `${agentName} left the group`);
        fs.rmSync(agDir, { recursive: true, force: true });
        writeAudit({ agent: agentName, action: 'group.leave', resource: `group:${group}` });
        triggerPoll(agentName, group);

        // ── EventBus: task.completed (agent leaving = completed that scope) ──
        emitBusEvent('task.completed', {
          taskId: `group:${group}`,
          by: agentName,
          duration: 0,
        }, agentName);

        respond(id, { content: [{ type: 'text', text: `left ${group}` }] });
        return;
      }

      // ── agent_memory ──
      if (name === 'agent_memory') {
        const { action, key, value, query } = a;
        if (action === 'write' && key && value) {
          const entry = writeMemory(agentName, key, value);
          writeAudit({ agent: agentName, action: 'memory.write', resource: `memory:${key}`, details: value.slice(0, 100) });
          respond(id, { content: [{ type: 'text', text: `记忆已保存: ${entry.key} (${entry.content.length} 字符)` }] });
          return;
        }
        if (action === 'read' && key) {
          const entry = readMemory(agentName, key);
          respond(id, { content: [{ type: 'text', text: entry ? `# ${entry.key}\n\n${entry.content}\n\n保存于: ${new Date(entry.created).toISOString()}` : `记忆 "${key}" 未找到` }] });
          return;
        }
        if (action === 'search' && query) {
          const results = await searchMemory(agentName, query);
          respond(id, { content: [{ type: 'text', text: results.length > 0 ? results.map((r, i) => `${i + 1}. **${r.key}**: ${r.content.slice(0, 150)}`).join('\n') : `未找到与 "${query}" 相关的记忆` }] });
          return;
        }
        if (action === 'list') {
          const mems = listMemory(agentName);
          respond(id, { content: [{ type: 'text', text: mems.length > 0 ? mems.map((m, i) => `${i + 1}. **${m.key}** (${new Date(m.updated).toISOString()}): ${m.content.slice(0, 100)}`).join('\n') : '暂无长期记忆' }] });
          return;
        }
        if (action === 'delete' && key) {
          const ok = deleteMemory(agentName, key);
          writeAudit({ agent: agentName, action: 'memory.delete', resource: `memory:${key}` });
          respond(id, { content: [{ type: 'text', text: ok ? `已删除记忆: ${key}` : `记忆 "${key}" 未找到` }] });
          return;
        }
        respond(id, { content: [{ type: 'text', text: '无效操作。支持: write, read, search, list, delete。write 需要 key+value，read/delete 需要 key，search 需要 query。' }], isError: true });
        return;
      }

      if (name === 'agent_create') {
        const { name: newName, roles: rolesStr, autoRespond } = a;
        if (!newName || !rolesStr) { respond(id, { content: [{ type: 'text', text: 'name and roles required' }], isError: true }); return; }
        if (!/^[a-zA-Z0-9_-]+$/.test(newName)) { respond(id, { content: [{ type: 'text', text: 'invalid name' }], isError: true }); return; }
        const AgentsDir = path.join(PROJECT_ROOT, 'Agents', newName);
        if (exists(AgentsDir)) { respond(id, { content: [{ type: 'text', text: `agent ${newName} already exists` }] }); return; }
        const roles = rolesStr.split(',').map((r: string) => r.trim());
        fs.mkdirSync(path.join(AgentsDir, 'email'), { recursive: true });
        fs.mkdirSync(path.join(AgentsDir, 'chat'), { recursive: true });
        fs.mkdirSync(path.join(AgentsDir, '.claude'), { recursive: true });
        fs.writeFileSync(path.join(AgentsDir, 'CLAUDE.md'), `# 规则\n\n你的名字是 ${newName}。你是 Mind Agency 团队的一员。\n角色：${roles.join(', ')}。\n不能在自己 email/ 下添加/修改文件。\n给其他人发邮件时在对方 email/ 下创建 .md 文件。\n`, 'utf-8');
        fs.writeFileSync(path.join(AgentsDir, '.claude', 'CLAUDE.md'), `你的名字是 ${newName}。角色：${roles.join(', ')}。`, 'utf-8');
        fs.writeFileSync(path.join(AgentsDir, 'config.json'), JSON.stringify({ autoRespondToEmail: autoRespond ?? true, roles, permissions: roles.includes('PM') || roles.includes('CEO') ? { canCreateGroup: true, canDeleteGroup: true, canDeploy: true } : { canCreateGroup: false, canDeleteGroup: false, canDeploy: false } }, null, 2), 'utf-8');
        writeAudit({ agent: agentName, action: 'agent.create', resource: `agent:${newName}`, details: `roles: ${roles.join(',')}` });

        // ── EventBus: task.created (new agent = new system capability) ──
        emitBusEvent('task.created', {
          taskId: `agent:${newName}`,
          title: `Agent ${newName} onboarded (${roles.join(', ')})`,
          createdBy: agentName,
          priority: 'high',
        }, agentName);

        // ── EventBus: agent.status.changed (new agent online) ───────────
        emitBusEvent('agent.status.changed', {
          agent: newName,
          status: 'idle',
          since: Date.now(),
        }, agentName);

        respond(id, { content: [{ type: 'text', text: `created ${newName} (${roles.join(', ')}). Tell them to use group_join if they need to join a group.` }] });
        return;
      }

      // ── workflow_create ──
      if (name === 'workflow_create') {
        const { group, name: wfName, description: wfDesc, steps: stepsJson } = a;
        if (!group || !wfName || !stepsJson) {
          respond(id, { content: [{ type: 'text', text: 'group, name and steps required' }], isError: true });
          return;
        }
        const gDir = path.join(groupsDir(), group);
        if (!exists(gDir)) { respond(id, { content: [{ type: 'text', text: `group "${group}" not found` }], isError: true }); return; }

        // Parse steps
        let steps: any[];
        try { steps = JSON.parse(stepsJson); if (!Array.isArray(steps)) throw new Error(); } catch {
          respond(id, { content: [{ type: 'text', text: 'steps must be a valid JSON array' }], isError: true }); return;
        }

        // Build workflow.yaml
        const yamlLines = [
          `name: ${wfName}`,
          `description: "${wfDesc || `${wfName} workflow`}"`,
          'steps:',
        ];
        for (const s of steps) {
          yamlLines.push(`  - id: ${s.id || 'step_' + s.agent}`);
          yamlLines.push(`    agent: ${s.agent || 'unknown'}`);
          yamlLines.push(`    action: ${s.action || 'execute'}`);
          if (s.dependsOn) yamlLines.push(`    dependsOn: [${Array.isArray(s.dependsOn) ? s.dependsOn.join(', ') : s.dependsOn}]`);
          if (s.condition) yamlLines.push(`    condition: "${s.condition}"`);
          if (s.prompt) yamlLines.push(`    prompt: |\n      ${s.prompt.replace(/\n/g, '\n      ')}`);
          if (s.priority) yamlLines.push(`    priority: ${s.priority}`);
          if (s.retry) yamlLines.push(`    retry: ${s.retry}`);
          if (s.timeout) yamlLines.push(`    timeout: ${s.timeout}`);
        }

        fs.writeFileSync(path.join(gDir, 'workflow.yaml'), yamlLines.join('\n') + '\n', 'utf-8');
        writeAudit({ agent: agentName, action: 'workflow.create', resource: `group:${group}`, details: `workflow: ${wfName}` });

        // Post to group chat
        appendToChat(group, agentName, `创建了 workflow "${wfName}" (${steps.length} steps)`);
        triggerPoll(agentName, group);

        respond(id, { content: [{ type: 'text', text: `created workflow "${wfName}" in ${group}. Use workflow_trigger to start it.` }] });
        return;
      }

      if (name === 'group_create') {
        const { group } = a;
        if (!group) { respond(id, { content: [{ type: 'text', text: 'group name required' }], isError: true }); return; }
        if (!checkPermission(agentName, 'canCreateGroup')) {
          respond(id, { content: [{ type: 'text', text: `permission denied: ${agentName} does not have canCreateGroup permission` }], isError: true });
          writeAudit({ agent: agentName, action: 'group.create', resource: `group:${group}`, details: 'permission denied', status: 'error' });
          return;
        }
        const gDir = path.join(groupsDir(), group);
        if (exists(gDir)) { respond(id, { content: [{ type: 'text', text: `group "${group}" already exists` }], isError: true }); return; }
        // Create group structure
        fs.mkdirSync(path.join(gDir, 'Agents', agentName, 'email'), { recursive: true });
        fs.mkdirSync(path.join(gDir, 'chat'), { recursive: true });
        // Write default TASK_SPEC
        const spec = `# 任务流转规范\n\n任务在 work/<group>/ 下按目录流转，**文件位置即状态**。\n\n## 目录结构\n\n\`\`\`\nwork/<group>/\n├── inbox/                  # 待分配\n├── assigned/<agent>/       # 各 Agent 的工作队列\n└── done/                   # 已完成\n\`\`\`\n\n## 状态流转\n\n\`\`\`\ninbox/ → assigned/<agent>/ → done/\n  ↓           ↓                  ↓\n new      in_progress          done\n\`\`\``;
        fs.writeFileSync(path.join(gDir, 'TASK_SPEC.md'), spec, 'utf-8');
        // Welcome message in chat (per-message file)
        appendToChat(group, 'system', `${group} 群组已创建。${agentName} 是创建者。`);
        writeAudit({ agent: agentName, action: 'group.create', resource: `group:${group}` });
        // Set creator as owner
        ensureGroupConfig(group, agentName);
        respond(id, { content: [{ type: 'text', text: `created group "${group}". You are the owner.` }] });
        return;
      }

      // ── group_set_admin ──
      if (name === 'group_set_admin') {
        const { group, agent: target, admin } = a;
        if (!group || !target) { respond(id, { content: [{ type: 'text', text: 'group and agent required' }], isError: true }); return; }
        if (!isGroupOwner(group, agentName)) {
          respond(id, { content: [{ type: 'text', text: `permission denied: only the group owner (${loadGroupConfig(group)?.owner}) can set admins` }], isError: true }); return;
        }
        const config = loadGroupConfig(group);
        if (!config) { respond(id, { content: [{ type: 'text', text: 'group config not found' }], isError: true }); return; }
        if (admin) {
          if (!config.admins.includes(target)) config.admins.push(target);
        } else {
          config.admins = config.admins.filter(a => a !== target);
        }
        saveGroupConfig(group, config);
        writeAudit({ agent: agentName, action: 'group.set_admin', resource: `group:${group}`, details: `${target} ${admin ? 'promoted to admin' : 'removed from admin'}` });
        respond(id, { content: [{ type: 'text', text: `${target} ${admin ? 'is now an admin' : 'is no longer an admin'} of ${group}` }] });
        return;
      }

      // ── group_invite ──
      if (name === 'group_invite') {
        const { group, agent: target } = a;
        if (!group || !target) { respond(id, { content: [{ type: 'text', text: 'group and agent required' }], isError: true }); return; }
        if (!isGroupAdmin(group, agentName)) {
          respond(id, { content: [{ type: 'text', text: `permission denied: you are not an admin of ${group}` }], isError: true }); return;
        }
        // Check if target already a member
        const tgtDir = path.join(groupsDir(), group, 'Agents', target);
        if (exists(tgtDir)) { respond(id, { content: [{ type: 'text', text: `${target} is already in ${group}` }] }); return; }

        // Write invitation file — target's heartbeat/scheduler will detect it
        const invDir = path.join(groupsDir(), group, '.invitations');
        if (!exists(invDir)) fs.mkdirSync(invDir, { recursive: true });
        const invFile = path.join(invDir, `${target.toLowerCase()}.json`);
        fs.writeFileSync(invFile, JSON.stringify({
          group, invitedBy: agentName, invitedAt: Date.now(),
        }, null, 2), 'utf-8');

        appendToChat(group, 'system', `${agentName} 邀请了 ${target} 加入群组（等待 ${target} 接受）`);
        writeAudit({ agent: agentName, action: 'group.invite', resource: `group:${group}`, details: `invited ${target}` });
        triggerPoll(target, group); // 通知被邀请的 Agent
        respond(id, { content: [{ type: 'text', text: `sent invitation to ${target} for ${group}` }] });
        return;
      }

      // ── group_kick ──
      if (name === 'group_kick') {
        const { group, agent: target } = a;
        if (!group || !target) { respond(id, { content: [{ type: 'text', text: 'group and agent required' }], isError: true }); return; }
        if (target.toLowerCase() === agentName.toLowerCase()) {
          respond(id, { content: [{ type: 'text', text: 'cannot kick yourself. Use group_leave instead.' }], isError: true }); return;
        }
        if (!isGroupAdmin(group, agentName)) {
          respond(id, { content: [{ type: 'text', text: `permission denied: you are not an admin of ${group}` }], isError: true }); return;
        }
        // Admins cannot be kicked by non-owners
        const config = loadGroupConfig(group);
        if (config && config.admins.includes(target) && !isGroupOwner(group, agentName)) {
          respond(id, { content: [{ type: 'text', text: `permission denied: only the group owner can kick admins` }], isError: true }); return;
        }
        if (kickMember(group, target)) {
          appendToChat(group, 'system', `${target} 被 ${agentName} 踢出了群组`);
          writeAudit({ agent: agentName, action: 'group.kick', resource: `group:${group}`, details: `kicked ${target}` });
          triggerPoll(agentName, group);
          respond(id, { content: [{ type: 'text', text: `kicked ${target} from ${group}` }] });
        } else {
          respond(id, { content: [{ type: 'text', text: `${target} is not in ${group}` }] });
        }
        return;
      }

      // ── group_delete ──
      if (name === 'group_delete') {
        const { group } = a;
        if (!group) { respond(id, { content: [{ type: 'text', text: 'group required' }], isError: true }); return; }
        if (!checkPermission(agentName, 'canDeleteGroup') && !isGroupOwner(group, agentName)) {
          respond(id, { content: [{ type: 'text', text: 'permission denied: need canDeleteGroup or be group owner' }], isError: true });
          writeAudit({ agent: agentName, action: 'group.delete', resource: `group:${group}`, details: 'permission denied', status: 'error' });
          return;
        }
        const gDir = path.join(groupsDir(), group);
        if (!exists(gDir)) { respond(id, { content: [{ type: 'text', text: `group "${group}" not found` }], isError: true }); return; }
        fs.rmSync(gDir, { recursive: true, force: true });
        writeAudit({ agent: agentName, action: 'group.delete', resource: `group:${group}` });
        emitBusEvent('task.completed', { taskId: `group:${group}`, by: agentName, action: 'group_delete' }, agentName);
        respond(id, { content: [{ type: 'text', text: `deleted group "${group}"` }] });
        return;
      }

      // ── workflow_trigger ──
      if (name === 'workflow_trigger') {
        const { group } = a;
        if (!group) { respond(id, { content: [{ type: 'text', text: 'group required' }], isError: true }); return; }
        const wfPath = path.join(groupsDir(), group, 'workflow.yaml');
        if (!exists(wfPath)) { respond(id, { content: [{ type: 'text', text: `no workflow.yaml in ${group}` }], isError: true }); return; }
        httpPost(`${WS_BASE_URL}/workflows/run`, { yaml: fs.readFileSync(wfPath, 'utf-8'), group });
        emitBusEvent('task.created', { title: `Workflow triggered for ${group}`, agent: agentName, group }, agentName);
        respond(id, { content: [{ type: 'text', text: `workflow triggered for group "${group}"` }] });
        return;
      }

      // ── workflow_status ──
      if (name === 'workflow_status') {
        const { group } = a;
        httpPost(`${WS_BASE_URL}/workflows/status`, { group });
        // Read stats from WS server
        let statsText = 'no active runs';
        try {
          const data = await fetchJSON(`${WS_BASE_URL}/workflows/stats`);
          const runs = (data as any)?.runs || [];
          const filtered = group ? runs.filter((r: any) => r.workflowName?.includes(group)) : runs;
          statsText = filtered.length > 0
            ? JSON.stringify(filtered.map((r: any) => ({ workflow: r.workflowName, status: r.status, steps: r.stepCount, started: new Date(r.startedAt).toISOString() })), null, 2)
            : 'no active runs';
        } catch {}
        respond(id, { content: [{ type: 'text', text: statsText }] });
        return;
      }

      // ── workflow_approve ──
      if (name === 'workflow_approve') {
        const { group, approvalId, decision } = a;
        if (!group || !approvalId || !decision) { respond(id, { content: [{ type: 'text', text: 'group, approvalId, decision required' }], isError: true }); return; }
        httpPost(`${WS_BASE_URL}/workflows/approve`, { approvalId, decision });
        emitBusEvent('task.completed', { taskId: `workflow:${group}`, by: agentName, decision, approvalId }, agentName);
        respond(id, { content: [{ type: 'text', text: `approval ${decision} submitted for ${approvalId}` }] });
        return;
      }

      // ── workflow_cancel (v0.4) ──
      if (name === 'workflow_cancel') {
        const { group } = a;
        if (!group) { respond(id, { content: [{ type: 'text', text: 'group required' }], isError: true }); return; }
        // Get active run for this group, then cancel
        try {
          const runsRaw = await fetchJSON(`${WS_BASE_URL}/workflows/stats`);
          const runs = (runsRaw as any)?.runs || [];
          const activeRun = runs.find((r: any) => r.group === group && r.status === 'running');
          if (!activeRun) {
            respond(id, { content: [{ type: 'text', text: `no active workflow in ${group}` }] });
            return;
          }
          httpPost(`${WS_BASE_URL}/workflows/cancel`, { runId: activeRun.runId });
          respond(id, { content: [{ type: 'text', text: `workflow cancelled for ${group}` }] });
        } catch {
          respond(id, { content: [{ type: 'text', text: 'failed to cancel workflow' }], isError: true });
        }
        return;
      }

      // ── email_send — structured email via MCP (not Write) ──
      if (name === 'email_send') {
        const { to, subject, body: emailBody } = a;
        if (!to || !subject) { respond(id, { content: [{ type: 'text', text: 'to and subject required' }], isError: true }); return; }
        const recipientDir = path.join(PROJECT_ROOT, 'Agents', to);
        if (!exists(recipientDir)) { respond(id, { content: [{ type: 'text', text: `agent "${to}" not found` }], isError: true }); return; }

        const emailDir = path.join(recipientDir, 'email');
        if (!exists(emailDir)) fs.mkdirSync(emailDir, { recursive: true });

        const date = new Date();
        const dateStr = date.toISOString().split('T')[0];
        const safeSubject = subject.replace(/[^a-zA-Z0-9一-鿿\s\-_]/g, '').replace(/\s+/g, '_').slice(0, 50);
        let filename = `${dateStr}_${safeSubject || 'no_subject'}.md`;
        let c = 1;
        while (exists(path.join(emailDir, filename))) { filename = `${dateStr}_${safeSubject}_${c++}.md`; }

        const content = `---\nfrom: ${agentName}\nto: ${to}\nsubject: ${subject}\ndate: ${dateStr}\n---\n\n${emailBody || ''}\n`;
        fs.writeFileSync(path.join(emailDir, filename), content, 'utf-8');

        // Also save sent copy to sender
        const senderEmailDir = path.join(PROJECT_ROOT, 'Agents', agentName, 'email');
        if (exists(path.join(PROJECT_ROOT, 'Agents', agentName))) {
          if (!exists(senderEmailDir)) fs.mkdirSync(senderEmailDir, { recursive: true });
          fs.writeFileSync(path.join(senderEmailDir, `sent_${filename}`), content, 'utf-8');
        }

        writeAudit({ agent: agentName, action: 'email.send', resource: `agent:${to}`, details: subject.slice(0, 100) });
        triggerPoll(to); // 通知收件人
        respond(id, { content: [{ type: 'text', text: `邮件已发送给 ${to}: ${subject}` }] });
        return;
      }

      // ── decide — general-purpose structured decision ──
      // Works for: consensus votes, workflow approvals, AND group invitations.
      if (name === 'decide') {
        const { group, decision, reason, requestId } = a;
        if (!group || !decision) { respond(id, { content: [{ type: 'text', text: 'group and decision required' }], isError: true }); return; }

        const dec = decision.toUpperCase();
        if (!['APPROVED','REJECTED'].includes(dec)) {
          respond(id, { content: [{ type: 'text', text: 'decision must be APPROVED or REJECTED' }], isError: true });
          return;
        }

        // ── Path I: Group invitation response ──
        const invDir = path.join(groupsDir(), group, '.invitations');
        const invFile = path.join(invDir, `${agentName.toLowerCase()}.json`);
        if (exists(invFile)) {
          try {
            if (dec === 'APPROVED') {
              // Accept invitation
              fs.unlinkSync(invFile);
              const agDir = path.join(groupsDir(), group, 'Agents', agentName);
              if (!exists(path.join(agDir, 'email'))) fs.mkdirSync(path.join(agDir, 'email'), { recursive: true });
              appendToChat(group, 'system', `${agentName} 接受了邀请并加入了群组`);
              writeAudit({ agent: agentName, action: 'group.join', resource: `group:${group}`, details: 'accepted invitation via decide' });
              respond(id, { content: [{ type: 'text', text: `✅ 已接受 ${group} 的邀请，加入了群组` }] });
            } else {
              // Reject invitation
              fs.unlinkSync(invFile);
              appendToChat(group, 'system', `${agentName} 拒绝了群组邀请`);
              writeAudit({ agent: agentName, action: 'group.invite.reject', resource: `group:${group}`, details: 'rejected invitation via decide' });
              respond(id, { content: [{ type: 'text', text: `❌ 已拒绝 ${group} 的邀请` }] });
            }
            triggerPoll(agentName, group);
            return;
          } catch { /* fall through to consensus paths */ }
        }

        // ── Path A: Specific consensus request ID ──
        if (requestId) {
          const result = submitDecision(group, requestId, agentName, dec as 'APPROVED' | 'REJECTED');
          if (result.status === 'approved') {
            respond(id, { content: [{ type: 'text', text: `✅ 共识 #${requestId} 已批准` }] });
          } else if (result.status === 'rejected') {
            respond(id, { content: [{ type: 'text', text: `❌ 共识 #${requestId} 已拒绝` }] });
          } else if (result.status === 'not_an_approver') {
            respond(id, { content: [{ type: 'text', text: '你不是该共识请求的审批人' }], isError: true });
          } else {
            respond(id, { content: [{ type: 'text', text: `已记录。还需要更多批准 (${Object.keys(result.request?.decisions || {}).length}/${(result.request?.approvers?.length || 0)})` }] });
          }
          writeAudit({ agent: agentName, action: 'consensus.decide', resource: `group:${group}`, details: `${dec} on #${requestId}` });
          return;
        }

        // ── Path B: Auto-match pending requests for this agent ──
        const pending = listPendingRequests(group);
        const myRequests = pending.filter(r =>
          r.approvers.some(a => a.toLowerCase() === agentName.toLowerCase()) &&
          !(r.decisions[agentName])
        );

        if (myRequests.length === 1) {
          const result = submitDecision(group, myRequests[0].id, agentName, dec as 'APPROVED' | 'REJECTED');
          const rtext = result.status === 'approved' ? '✅ 已批准' : result.status === 'rejected' ? '❌ 已拒绝' : '已记录';
          respond(id, { content: [{ type: 'text', text: `${rtext} 共识 #${myRequests[0].id}` }] });
        } else if (myRequests.length > 1) {
          const list = myRequests.map(r => `#${r.id}: ${r.description} (需 ${r.approvers.join(',')})`).join('\n');
          respond(id, { content: [{ type: 'text', text: `有 ${myRequests.length} 个待审批请求，请用 requestId 指定：\n${list}` }], isError: true });
        } else {
          // ── Path C: No consensus request found — fall back to legacy .decisions/ ──
          const decisionsDir = path.join(groupsDir(), group, '.decisions');
          if (!exists(decisionsDir)) fs.mkdirSync(decisionsDir, { recursive: true });
          const decFile = path.join(decisionsDir, `${Date.now()}_${agentName}_${dec}.json`);
          fs.writeFileSync(decFile, JSON.stringify({
            agent: agentName, group, decision: dec, reason: reason || '', timestamp: Date.now(),
          }), 'utf-8');
          appendToChat(group, agentName, `[decision] **${dec}**${reason ? ' (' + reason + ')' : ''}`);
          respond(id, { content: [{ type: 'text', text: `决策已记录：${dec} → ${group}（无待审批请求，已写入 .decisions/）` }] });
        }

        writeAudit({ agent: agentName, action: 'workflow.decide', resource: `group:${group}`, details: dec });
        triggerPoll(agentName, group);
        return;
      }

      // ── consensus_list ──
      if (name === 'consensus_list') {
        const { group: g } = a;
        if (g) {
          const pending = listPendingRequests(g);
          if (pending.length === 0) {
            respond(id, { content: [{ type: 'text', text: `${g} 群暂无待审批的共识请求` }] });
          } else {
            const list = pending.map(r => `#${r.id}: ${r.description} [需: ${r.approvers.join(',')}] [已批: ${Object.keys(r.decisions).join(',') || '无'}]`).join('\n');
            respond(id, { content: [{ type: 'text', text: `${g} 群 ${pending.length} 个待审批:\n${list}` }] });
          }
        } else {
          // No group specified: list requests where this agent is an approver
          const groupsDir = groupsDir();
          if (!exists(groupsDir)) { respond(id, { content: [{ type: 'text', text: '暂无' }] }); return; }
          let all: string[] = [];
          for (const gd of readDir(groupsDir).filter(e => e.isDirectory())) {
            const pending = listPendingRequests(gd.name);
            for (const r of pending) {
              if (r.approvers.some(a => a.toLowerCase() === agentName.toLowerCase())) {
                all.push(`[${gd.name}] #${r.id}: ${r.description}`);
              }
            }
          }
          if (all.length === 0) {
            respond(id, { content: [{ type: 'text', text: '你目前没有待审批的共识请求' }] });
          } else {
            respond(id, { content: [{ type: 'text', text: `你有 ${all.length} 个待审批:\n${all.join('\n')}` }] });
          }
        }
        return;
      }

      // ── group_set_role (owner only) ──
      if (name === 'group_set_role') {
        const { group, agent: target, role } = a;
        if (!group || !target || !role) { respond(id, { content: [{ type: 'text', text: 'group, agent and role required' }], isError: true }); return; }
        if (!['owner', 'admin', 'member'].includes(role)) { respond(id, { content: [{ type: 'text', text: 'role must be owner, admin, or member' }], isError: true }); return; }
        if (!isGroupOwner(group, agentName)) { respond(id, { content: [{ type: 'text', text: 'permission denied: only the group owner can set roles' }], isError: true }); return; }
        const ok = setMemberRole(group, target, role);
        if (ok) {
          appendToChat(group, 'system', `${agentName} 将 ${target} 的角色设为 ${role}`);
          writeAudit({ agent: agentName, action: 'group.set_role', resource: `group:${group}`, details: `${target} → ${role}` });
          respond(id, { content: [{ type: 'text', text: `${target} 的角色已设为 ${role}` }] });
        } else {
          respond(id, { content: [{ type: 'text', text: '群组不存在' }], isError: true });
        }
        return;
      }

      // ── group_get_info ──
      if (name === 'group_get_info') {
        const { group } = a;
        if (!group) { respond(id, { content: [{ type: 'text', text: 'group required' }], isError: true }); return; }
        const info = getGroupInfo(group);
        if (!info) { respond(id, { content: [{ type: 'text', text: `group "${group}" not found` }], isError: true }); return; }
        respond(id, { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] });
        return;
      }

      // ── group_set_info (admin only) ──
      if (name === 'group_set_info') {
        const { group, name: newName, description } = a;
        if (!group) { respond(id, { content: [{ type: 'text', text: 'group required' }], isError: true }); return; }
        if (!newName && !description) { respond(id, { content: [{ type: 'text', text: '至少提供 name 或 description 之一' }], isError: true }); return; }
        if (!isGroupAdmin(group, agentName)) { respond(id, { content: [{ type: 'text', text: 'permission denied: need admin role' }], isError: true }); return; }
        const ok = setGroupInfo(group, { name: newName, description });
        writeAudit({ agent: agentName, action: 'group.set_info', resource: `group:${group}`, details: `name=${newName || '(unchanged)'} desc=${(description || '').slice(0, 100)}` });
        respond(id, { content: [{ type: 'text', text: ok ? `群信息已更新` : '群组不存在' }] });
        return;
      }

      // ── group_announce (admin only) ──
      if (name === 'group_announce') {
        const { group, title, content, clear } = a;
        if (!group) { respond(id, { content: [{ type: 'text', text: 'group required' }], isError: true }); return; }
        if (!isGroupAdmin(group, agentName)) { respond(id, { content: [{ type: 'text', text: 'permission denied: need admin role' }], isError: true }); return; }
        if (clear) {
          removeGroupAnnouncement(group);
          writeAudit({ agent: agentName, action: 'group.announce.remove', resource: `group:${group}` });
          respond(id, { content: [{ type: 'text', text: '公告已移除' }] });
        } else {
          if (!title || !content) { respond(id, { content: [{ type: 'text', text: '发布公告需要 title 和 content' }], isError: true }); return; }
          setGroupAnnouncement(group, title, content, agentName);
          appendToChat(group, 'system', `📢 新公告: ${title}`);
          writeAudit({ agent: agentName, action: 'group.announce', resource: `group:${group}`, details: title });
          respond(id, { content: [{ type: 'text', text: `公告已发布: ${title}` }] });
        }
        return;
      }

      respond(id, { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true });
      return;
    }

    respond(id, { content: [{ type: 'text', text: `unknown: ${method}` }], isError: true });
  } catch (e: any) { respond(id, { content: [{ type: 'text', text: e.message }], isError: true }); }
});

function respond(id: any, result: any) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }

// Parse agent name from args
for (const a of process.argv.slice(2)) { if (!a.startsWith('-') && !a.endsWith('.ts') && !a.endsWith('.js')) { agentName = a; break; } }

process.stderr.write(`[group-mcp] agent=${agentName} project=${PROJECT_ROOT}\n`);
if (exists(groupsDir())) {
  for (const d of readDir(groupsDir()).filter(e => e.isDirectory())) {
    process.stderr.write(`[group-mcp]   ${d.name}/Agents/${agentName}: ${exists(path.join(groupsDir(), d.name, 'Agents', agentName))}\n`);
  }
}
