/**
 * POST /api/test/scenario — Execute a test scenario
 *
 * Runs a sequence of steps (chat, email, poll) against agents for
 * integration testing. Steps execute sequentially and results are
 * returned as an array.
 *
 * Body: { steps: [{ agent, msg?, group?, emailTo?, emailSubject?, emailBody?, poll? }] }
 */

import { NextRequest, NextResponse } from 'next/server';
import { chatOnce } from '@/lib/chat';
import { autoRespond } from '@/lib/auto-respond';
import { sendEmail } from '@/lib/emails';

export async function POST(request: NextRequest) {
  try {
    const { steps } = await request.json();
    if (!Array.isArray(steps)) return NextResponse.json({ error: 'steps array required' }, { status: 400 });

    const results: any[] = [];

    for (const step of steps) {
      const stepResult: any = { step: step.agent || 'system' };

      if (step.msg) {
        // Chat message to specific agent
        try {
          const { reply } = await chatOnce(step.agent, step.msg, step.group || undefined);
          stepResult.type = 'chat';
          stepResult.reply = reply.slice(0, 500);
        } catch (e: any) {
          stepResult.error = e.message;
        }
      }

      if (step.emailTo) {
        // Send email
        const result = await sendEmail({
          from: step.agent,
          to: step.emailTo,
          subject: step.emailSubject || 'No subject',
          body: step.emailBody || '',
        });
        stepResult.type = 'email';
        stepResult.emailResult = result;
      }

      if (step.poll) {
        // Poll for auto-respond
        try {
          const ar = await autoRespond(step.agent);
          stepResult.type = 'poll';
          stepResult.triggered = ar.triggered;
          stepResult.reply = ar.reply?.slice(0, 300);
        } catch (e: any) {
          stepResult.error = e.message;
        }
      }

      results.push(stepResult);
    }

    return NextResponse.json({ results });
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
}
