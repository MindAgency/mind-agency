/**
 * Emails API — inter-agent email messaging
 *
 * GET    /api/emails?agent=<name>&file=<file>     → list or read emails
 * POST   /api/emails                               → send an email between agents
 * DELETE /api/emails?agent=<name>&file=<file>       → delete an email
 *
 * Emails are stored as .eml files in each agent's directory.
 * Sending an email triggers auto-respond polling for the recipient.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAgentEmails, getEmail } from '@/lib/agents';
import { sendEmail, deleteEmail } from '@/lib/emails';
import { broadcastWs } from '@/lib/ws-embedded';
import { pollAllAgents } from '@/lib/auto-respond';
import { apiOk, apiNotFound, apiBadRequest, apiInternal } from '@/lib/api-utils';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const agent = searchParams.get('agent');
    const file = searchParams.get('file');
    if (!agent) return apiBadRequest('缺少 agent');
    if (file) {
      const email = getEmail(agent, file);
      if (!email) return apiNotFound('邮件不存在');
      return Response.json(email, { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }
    const emails = getAgentEmails(agent);
    return Response.json(emails, { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  } catch {
    return apiInternal('Failed to load emails');
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { from, to, subject, body: emailBody, content } = body;
    if (!from || !to) return apiBadRequest('缺少必填字段 from/to');
    const result = await sendEmail({ from, to, subject: subject || '(no subject)', body: emailBody || content || '' });
    if (!result.success) return apiBadRequest(result.error!);
    // Fire-and-forget: trigger auto-respond immediately, don't block response
    pollAllAgents().catch(() => {});

    broadcastWs('email', { to, from, subject: subject || '(no subject)' });
    return apiOk({ filename: result.filename, message: `已发送给 ${to}` });
  } catch { return apiBadRequest('请求格式错误'); }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const agent = searchParams.get('agent');
    const file = searchParams.get('file');
    if (!agent || !file) return apiBadRequest('缺少参数');
    const result = await deleteEmail(agent, file);
    if (!result.success) return apiBadRequest(result.error!);
    return apiOk({ message: '已删除' });
  } catch {
    return apiInternal('Failed to delete email');
  }
}
