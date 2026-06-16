'use client';
import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';

type Lang = 'zh' | 'en';

const messages: Record<Lang, Record<string, string>> = {
  zh: {
    // Nav / sidebar
    'dashboard': '总览', 'workflows': '工作流', 'usage': '用量', 'audit': '审计', 'settings': '配置', 'learning': '学习', 'management': '管理台',
    'expand_sidebar': '展开侧边栏', 'collapse_sidebar': '收起侧边栏',
    'teams': '群组', 'members': '成员', 'me': '我', 'visualization': '可视化',
    // Stats
    'agents': 'Agents', 'groups': '群组', 'emails': '邮件', 'active': '活跃', 'idle': '空闲',
    // Labels
    'agent': 'Agent', 'group': 'Group', 'member': '成员', 'admin': '管理员',
    'language': '语言', 'from': '发件人', 'to': '收件人', 'subject': '主题', 'body': '正文',
    // Buttons
    'create': '创建', 'creating': '创建中...', 'save': '保存', 'save_config': '保存配置',
    'send': '发送', 'sending': '发送中...', 'compose': '写邮件', 'reply': '回复', 'cancel': '取消', 'delete': '删除',
    'refresh': '刷新', 'edit': '编辑', 'clear': '清空', 'close': '关闭',
    // AI actions
    'approve': '同意', 'reject': '拒绝', 'verify': '验证', 'deploy': '部署',
    // Email
    'inbox': '收件箱', 'sent': '已发送', 'all_read': '全部已读',
    'new_email': '新邮件', 'new_message': '新建消息', 'select_contact': '选择联系人',
    'no_sent': '暂无已发送邮件', 'no_emails': '收件箱为空',
    'no_email_thread': '暂无邮件往来',
    'email_select_hint': '选择左侧联系人或点击上方写邮件',
    'no_subject': '(无主题)',
    'emails_count': '{n} 封', 'sent_success': '已发送给',
    // Chat
    'start_conversation': '开始与 {name} 对话', 'try_help': '输入 /help 查看指令',
    'no_messages': '暂无消息，在下方发言',
    'input_placeholder': '输入消息... (@name 提及, /cmd 指令)',
    // Commands
    'cmd_help_desc': '显示此帮助',
    'cmd_newgroup_desc': '创建新群组 — /newgroup <名称>',
    'cmd_invite_desc': '邀请 Agent 加入群组 — /invite <agent> to <group>',
    'cmd_consensus_desc': '发起共识投票 — /consensus <主题>',
    'cmd_deploy_desc': '触发部署流水线 — /deploy <环境>',
    'cmd_status_desc': '查看系统状态',
    // Workflow
    'workflow_title': 'DAG 流水线管理',
    'workflow_steps': '{n} 步骤',
    'no_workflows': '暂无 workflow。创建 Groups/&lt;name&gt;/workflow.yaml 开始使用。',
    'edit_yaml': '编辑 YAML',
    // Approval
    'approval_pending': '等待审批', 'pending': '待审批', 'approval_required': '需要 {n} 人审批',
    'approved': '已通过', 'rejected': '已拒绝',
    // Dashboard
    'welcome': '欢迎使用 Mind Agency',
    'welcome_desc': '多 Agent 协作平台 — 创建 Agent、组建群组、编排工作流',
    'new_agent': '新建 Agent', 'new_group': '新建群组',
    'enable_auto_reply': '启用自动回复',
    'realtime_activity': '实时活动',
    'no_activity': '暂无活动，等待 Agent 响应...',
    'agent_status': 'Agent 状态',
    // Delete
    'delete_confirm_title': '删除 {name}？',
    'delete_warning': '此操作不可撤销。',
    // Settings
    'api_key': 'API 密钥', 'base_url': 'Base URL', 'model': '模型',
    'port': 'HTTP 端口', 'ws_port': 'WS 端口',
    'api_key_desc': '支持 Anthropic API 或兼容代理（如 DeepSeek）',
    'base_url_desc': '默认: api.anthropic.com。使用 DeepSeek 代理填 https://api.deepseek.com/anthropic',
    'model_desc': 'DeepSeek 用户填 DeepSeek-V4-Pro',
    'restart_note': '修改后需要重启应用生效。',
    // Analytics
    'cost_center': '成本中心', 'token_tracking': 'Token 消耗追踪',
    'total_cost': '总花费', 'total_tokens': '总 Token', 'calls': '调用次数',
    'input_tokens': '输入 {n} T', 'output_tokens': '输出 {n} T',
    'calls_count': '{n} 次',
    // Audit
    'audit_log': '审计日志', 'audit_desc': '所有操作记录', 'no_records': '暂无记录', 'all': '全部',
    'prev_page': '上一页', 'next_page': '下一页', 'page_n': '第 {n} 页',
    // Time
    'today': '今日', 'week': '本周', 'month': '本月',
    'loading': '加载中...',
    // System
    'cpu': 'CPU', 'uptime': '运行时间',
    // Notifications
    'notifications': '通知',
    // Misc
    'no_groups': '暂无群组，点击右上角创建',
    'create_first_agent': '创建第一个 Agent',
    'create_first_group': '创建第一个群组',
    'new_email_toast': '新邮件',
    'name_required': '请输入名称',
    'network_error': '网络错误',
    'saved_ok': '✅ 已保存。重启后生效。',
    'save_failed': '保存失败',
    'just_now': '刚刚', 'min_ago': '{n}分前', 'hour_ago': '{n}时前',
    'agents_groups_count': '{a} agents · {g} groups',
    'list_view': '列表视图', 'dag_view': 'DAG 视图',
    'run': '启动', 'running': '运行中...',
    'saving': '保存中...',
    'add_step': '添加', 'add_first_step': '添加第一个步骤',
    'steps_label': 'Steps ({n})',
    // Agent page
    'config': '配置', 'email': '邮箱', 'operations': '操作', 'tasks': '任务',
    'no_records_yet': '暂无操作记录', 'waiting': '等待中', 'executing': '执行中',
    'completed': '已完成', 'failed': '失败', 'skipped': '已跳过',
    'no_tasks': '暂无分配的任务',
    // Token economy
    'token_account': 'Token 账户', 'total_income': '累计收入', 'total_expense': '累计支出',
    'recent_transactions': '最近交易', 'deposit': '存入', 'reward': '奖励',
    'quality_bonus': '优质', 'transfer_in': '转入', 'transfer_out': '转出',
    'deduction': '扣费', 'penalty': '处罚',
    // Dashboard
    'pending_approval': '待审批', 'consensus': '共识',
    'token_leaderboard': 'Token 排行榜', 'balance': '余额',
    'open_tasks': '开放任务', 'offline': '离线', 'recent_activity': '最近活动',
    // Provider
    'ai_provider': 'AI Provider', 'heartbeat_minutes': 'Heartbeat (分钟, 0=关闭)',
    'switch_provider_hint': '切换后新对话从头开始，旧记录保留',
    // Misc
    'no_group': '无群组', 'total_records': '总记录', 'avg_score': '平均分',
  },
  en: {
    // Nav / sidebar
    'dashboard': 'Dashboard', 'workflows': 'Workflows', 'usage': 'Usage', 'audit': 'Audit', 'settings': 'Settings', 'learning': 'Learning', 'management': 'Management',
    'expand_sidebar': 'Expand sidebar', 'collapse_sidebar': 'Collapse sidebar',
    'teams': 'Teams', 'members': 'Members', 'me': 'Me', 'visualization': 'Viz',
    // Stats
    'agents': 'Agents', 'groups': 'Groups', 'emails': 'Emails', 'active': 'Active', 'idle': 'Idle',
    // Labels
    'agent': 'Agent', 'group': 'Group', 'member': 'Member', 'admin': 'Admin',
    'language': 'Language', 'from': 'From', 'to': 'To', 'subject': 'Subject', 'body': 'Body',
    // Buttons
    'create': 'Create', 'creating': 'Creating...', 'save': 'Save', 'save_config': 'Save Config',
    'send': 'Send', 'sending': 'Sending...', 'compose': 'Compose', 'reply': 'Reply', 'cancel': 'Cancel', 'delete': 'Delete',
    'refresh': 'Refresh', 'edit': 'Edit', 'clear': 'Clear', 'close': 'Close',
    // AI actions
    'approve': 'Approve', 'reject': 'Reject', 'verify': 'Verify', 'deploy': 'Deploy',
    // Email
    'inbox': 'Inbox', 'sent': 'Sent', 'all_read': 'Mark all read',
    'new_email': 'New Email', 'new_message': 'New Message', 'select_contact': 'Select contact',
    'no_sent': 'No sent emails', 'no_emails': 'Inbox empty',
    'no_email_thread': 'No email exchange yet',
    'email_select_hint': 'Select a contact on the left or click Compose',
    'no_subject': '(no subject)',
    'emails_count': '{n} emails', 'sent_success': 'Sent to',
    // Chat
    'start_conversation': 'Start a conversation with {name}', 'try_help': 'Type /help for commands',
    'no_messages': 'No messages yet',
    'input_placeholder': 'Type a message... (@name to mention, /cmd for commands)',
    // Commands
    'cmd_help_desc': 'Show this help',
    'cmd_newgroup_desc': 'Create a new group — /newgroup <name>',
    'cmd_invite_desc': 'Invite an agent to a group — /invite <agent> to <group>',
    'cmd_consensus_desc': 'Start a consensus vote — /consensus <topic>',
    'cmd_deploy_desc': 'Trigger deploy pipeline — /deploy <env>',
    'cmd_status_desc': 'View system status',
    // Workflow
    'workflow_title': 'DAG Pipeline Management',
    'workflow_steps': '{n} steps',
    'no_workflows': 'No workflows yet. Create Groups/&lt;name&gt;/workflow.yaml to start.',
    'edit_yaml': 'Edit YAML',
    // Approval
    'approval_pending': 'Pending Approval', 'pending': 'Pending', 'approval_required': '{n} approvals needed',
    'approved': 'Approved', 'rejected': 'Rejected',
    // Dashboard
    'welcome': 'Welcome to Mind Agency',
    'welcome_desc': 'Multi-Agent Collaboration Platform — Create agents, form groups, orchestrate workflows',
    'new_agent': 'New Agent', 'new_group': 'New Group',
    'enable_auto_reply': 'Enable auto-reply',
    'realtime_activity': 'Live Activity',
    'no_activity': 'No activity yet, waiting for agents...',
    'agent_status': 'Agent Status',
    // Delete
    'delete_confirm_title': 'Delete {name}?',
    'delete_warning': 'This cannot be undone.',
    // Settings
    'api_key': 'API Key', 'base_url': 'Base URL', 'model': 'Model',
    'port': 'HTTP Port', 'ws_port': 'WS Port',
    'api_key_desc': 'Supports Anthropic API or compatible proxies (e.g. DeepSeek)',
    'base_url_desc': 'Default: api.anthropic.com. Use https://api.deepseek.com/anthropic for DeepSeek',
    'model_desc': 'Use DeepSeek-V4-Pro for DeepSeek',
    'restart_note': 'Changes take effect after restart.',
    // Analytics
    'cost_center': 'Cost Center', 'token_tracking': 'Token Consumption Tracking',
    'total_cost': 'Total Cost', 'total_tokens': 'Total Tokens', 'calls': 'Calls',
    'input_tokens': '{n} T input', 'output_tokens': '{n} T output',
    'calls_count': '{n} calls',
    // Audit
    'audit_log': 'Audit Log', 'audit_desc': 'All operation records', 'no_records': 'No records yet', 'all': 'All',
    'prev_page': 'Previous', 'next_page': 'Next', 'page_n': 'Page {n}',
    // Time
    'today': 'Today', 'week': 'Week', 'month': 'Month',
    'loading': 'Loading...',
    // System
    'cpu': 'CPU', 'uptime': 'Uptime',
    // Notifications
    'notifications': 'Notifications',
    // Misc
    'no_groups': 'No groups yet, create one above',
    'create_first_agent': 'Create First Agent',
    'create_first_group': 'Create First Group',
    'new_email_toast': 'New email',
    'name_required': 'Name is required',
    'network_error': 'Network error',
    'saved_ok': '✓ Saved. Restart to apply.',
    'save_failed': 'Save failed',
    'just_now': 'just now', 'min_ago': '{n}m ago', 'hour_ago': '{n}h ago',
    'agents_groups_count': '{a} agents · {g} groups',
    'list_view': 'List View', 'dag_view': 'DAG View',
    'run': 'Run', 'running': 'Running...',
    'saving': 'Saving...',
    'add_step': 'Add', 'add_first_step': 'Add First Step',
    'steps_label': 'Steps ({n})',
    // Agent page
    'config': 'Config', 'email': 'Email', 'operations': 'Operations', 'tasks': 'Tasks',
    'no_records_yet': 'No operation records yet', 'waiting': 'Waiting', 'executing': 'Executing',
    'completed': 'Completed', 'failed': 'Failed', 'skipped': 'Skipped',
    'no_tasks': 'No tasks assigned',
    // Token economy
    'token_account': 'Token Account', 'total_income': 'Total Income', 'total_expense': 'Total Expense',
    'recent_transactions': 'Recent Transactions', 'deposit': 'Deposit', 'reward': 'Reward',
    'quality_bonus': 'Quality Bonus', 'transfer_in': 'Transfer In', 'transfer_out': 'Transfer Out',
    'deduction': 'Deduction', 'penalty': 'Penalty',
    // Dashboard
    'pending_approval': 'Pending Approval', 'consensus': 'Consensus',
    'token_leaderboard': 'Token Leaderboard', 'balance': 'Balance',
    'open_tasks': 'Open Tasks', 'offline': 'Offline', 'recent_activity': 'Recent Activity',
    // Provider
    'ai_provider': 'AI Provider', 'heartbeat_minutes': 'Heartbeat (min, 0=off)',
    'switch_provider_hint': 'New conversations start fresh after switch, old records preserved',
    // Misc
    'no_group': 'No group', 'total_records': 'Total Records', 'avg_score': 'Avg Score',
  },
};

// Interpolate {key} placeholders
function fmt(tmpl: string, vars: Record<string, string|number>): string {
  let s = tmpl;
  for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
  return s;
}

interface I18nCtx { lang: Lang; t: (key: string, vars?: Record<string,string|number>) => string; setLang: (l: Lang) => void; }

const Ctx = createContext<I18nCtx>({ lang: 'zh', t: (k) => k, setLang: () => {} });

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>('zh');

  // Load saved language on mount (client-side only)
  useEffect(() => {
    try {
      const s = localStorage.getItem('mind-lang');
      if (s === 'en' || s === 'zh') setLang(s);
    } catch (e) { console.error('[components:i18n]', e); }
  }, []);

  const t = (key: string, vars?: Record<string,string|number>) => {
    const raw = messages[lang][key] || key;
    return vars ? fmt(raw, vars) : raw;
  };

  return <Ctx.Provider value={{ lang, t, setLang }}>{children}</Ctx.Provider>;
}

export function useT() { return useContext(Ctx); }
