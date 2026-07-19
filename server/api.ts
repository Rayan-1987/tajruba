import { randomUUID, createHash } from 'node:crypto';
import express, { Router, type Request, type Response } from 'express';
import type { Db } from './db.ts';
import {
  attachSession,
  clearSessionCookie,
  createSession,
  destroySession,
  hashPassword,
  readSessionToken,
  requireAuth,
  requireRole,
  setSessionCookie,
  verifyPassword
} from './auth.ts';
import { createDefaultAnalyzer, redactPii, shouldAlert } from './comments.ts';
import {
  INSTRUMENTS,
  PUBLIC_REPORTING_SAMPLE_THRESHOLD,
  RELIABLE_SAMPLE_THRESHOLD,
  SMALL_SAMPLE_THRESHOLD,
  scoreDomain,
  scoreInstrument,
  scoreNps,
  scoreQuestion,
  scoreYesNo,
  type InstrumentDefinition,
  type InstrumentItemValue
} from './scoring.ts';
import { DEFAULT_DEPARTMENTS, provisionTenantDefaults } from './provisioning.ts';
import {
  composeInvitationMessage,
  composePromsMessage,
  composePromsReminderMessage,
  composeResolutionMessage,
  createSmsProvider,
  type TenantSmsConfig
} from './sms.ts';
import { composePasswordResetEmail, createEmailProvider } from './email.ts';
import type { AnswerType, RecoveryStatus, Role, ServiceType } from './types.ts';

function uid(): string {
  return randomUUID();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// A PROMs link stays valid for `windowDays` after its due_date (the same window used to judge
// whether a response still counts as "on time" for the timepoint) — after that it is treated as
// expired rather than staying open indefinitely like the original bug allowed.
function isPromsWindowExpired(dueDate: string, windowDays: number): boolean {
  const expiry = new Date(dueDate);
  expiry.setDate(expiry.getDate() + windowDays);
  return Date.now() > expiry.getTime();
}

// Seeded instruments (PHQ9, GAD7, VAS_PAIN, ...) have a hand-written InstrumentDefinition in
// scoring.ts, sometimes with clinical severity bands that can't be derived generically. An
// instrument an admin creates through the UI has no such entry, so it falls back to a plain
// sum-of-items definition driven entirely by its own DB row — every instrument in this system
// scores as a reverse-scoring-aware sum (see computeInstrumentRaw), so no band function is the
// only real difference, and MCID/delta still work correctly without one.
function resolveInstrumentDefinition(code: string, higherIsBetter: number, mcidThreshold: number): InstrumentDefinition {
  const hardcoded = INSTRUMENTS[code];
  if (hardcoded) return hardcoded;
  return { code, minItems: 0, maxItems: Infinity, higherIsBetter: !!higherIsBetter, mcidThreshold };
}

function logAudit(
  db: Db,
  tenantId: string | null,
  userId: string | null,
  action: string,
  entity: string,
  entityId: string | null,
  metadata: unknown
): void {
  db.prepare('INSERT INTO audit_logs (id, tenant_id, user_id, action, entity, entity_id, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    uid(),
    tenantId,
    userId,
    action,
    entity,
    entityId,
    metadata ? JSON.stringify(metadata) : null
  );
}

interface TenantIntegrationsRow {
  tenant_id: string;
  sms_provider: string;
  sms_api_key: string | null;
  sms_sender_name: string | null;
  default_language: string;
  his_webhook_key_hash: string | null;
  his_webhook_enabled: number;
}

function getOrCreateIntegrationsRow(db: Db, tenantId: string): TenantIntegrationsRow {
  const existing = db.prepare('SELECT * FROM tenant_integrations WHERE tenant_id = ?').get(tenantId) as
    | TenantIntegrationsRow
    | undefined;
  if (existing) return existing;
  db.prepare('INSERT INTO tenant_integrations (tenant_id) VALUES (?)').run(tenantId);
  return db.prepare('SELECT * FROM tenant_integrations WHERE tenant_id = ?').get(tenantId) as unknown as TenantIntegrationsRow;
}

function getTenantSmsConfig(db: Db, tenantId: string): TenantSmsConfig {
  const row = getOrCreateIntegrationsRow(db, tenantId);
  return {
    provider: row.sms_provider,
    apiKey: row.sms_api_key,
    senderName: row.sms_sender_name,
    defaultLanguage: row.default_language === 'en' ? 'en' : 'ar'
  };
}

function maskSecret(value: string | null): string | null {
  if (!value) return null;
  if (value.length <= 4) return '••••';
  return `••••${value.slice(-4)}`;
}

// Sampling frame rules: never invite a number on the tenant's Do-Not-Contact list, and never
// invite the same patient twice within 90 days of their last invitation (avoids survey fatigue
// and duplicate-response bias, matching common CAHPS-program sampling frame practice).
const INVITATION_COOLDOWN_DAYS = 90;

function isEligibleForInvitation(db: Db, tenantId: string, phoneHash: string): { eligible: boolean; reason?: 'dnc' | 'cooldown' } {
  const onDncList = db
    .prepare('SELECT 1 FROM do_not_contact_list WHERE tenant_id = ? AND phone_hash = ?')
    .get(tenantId, phoneHash);
  if (onDncList) return { eligible: false, reason: 'dnc' };

  // Compared via SQLite's datetime() on both sides: created_at is stored in SQLite's own
  // 'YYYY-MM-DD HH:MM:SS' format while cooldownStart is a JS ISO string ('...THH:MM:SS.sssZ') —
  // a raw text comparison ties (and breaks the wrong way) whenever the two dates fall on the
  // same calendar day, so both must be normalized through datetime() before comparing.
  const cooldownStart = new Date(Date.now() - INVITATION_COOLDOWN_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const recentInvitation = db
    .prepare(
      'SELECT 1 FROM survey_invitations WHERE tenant_id = ? AND patient_phone_hash = ? AND datetime(created_at) >= datetime(?) LIMIT 1'
    )
    .get(tenantId, phoneHash, cooldownStart);
  if (recentInvitation) return { eligible: false, reason: 'cooldown' };

  return { eligible: true };
}

// Auto-sends any assignment across all tenants that is due, free-to-administer, has a contact
// phone on file, and whose patient hasn't opted out — the same eligibility rules as the manual
// "إرسال" button in PromsMonitor. Licensed instruments and episodes without a phone number are
// left scheduled for manual/clinical administration. Also sends a single reminder for
// assignments sent but not completed halfway through their response window, and flips anything
// past its full window (due_date + pathway_timepoints.window_days) to 'expired' so it stops
// showing as actionable. Intended to be called on an interval from server.ts.
export async function autoSendDuePromsAssignments(
  db: Db,
  baseUrl: string
): Promise<{ sent: number; failed: number; skipped: number; reminded: number; expired: number }> {
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let reminded = 0;
  let expired = 0;

  const dueRows = db
    .prepare(
      `SELECT pa.id, pe.tenant_id, pe.contact_phone, pi.name_ar as instrument_name_ar, pi.name_en as instrument_name_en,
              pi.license_status, pt.name_ar as timepoint_name_ar
       FROM prom_assignments pa
       JOIN patient_episodes pe ON pe.id = pa.episode_id
       JOIN proms_instruments pi ON pi.id = pa.instrument_id
       JOIN pathway_timepoints pt ON pt.id = pa.timepoint_id
       WHERE pa.status = 'scheduled' AND datetime(pa.due_date) <= datetime('now') AND pe.opted_out_at IS NULL`
    )
    .all() as {
    id: string;
    tenant_id: string;
    contact_phone: string | null;
    instrument_name_ar: string;
    instrument_name_en: string;
    license_status: string;
    timepoint_name_ar: string;
  }[];

  for (const assignment of dueRows) {
    if (assignment.license_status !== 'free' || !assignment.contact_phone) {
      skipped += 1;
      continue;
    }
    const rawToken = uid();
    const formUrl = `${baseUrl}/p/${rawToken}`;
    const optOutUrl = `${formUrl}/opt-out`;
    const smsConfig = getTenantSmsConfig(db, assignment.tenant_id);
    const provider = createSmsProvider(smsConfig);
    const message = composePromsMessage(
      assignment.instrument_name_ar,
      assignment.instrument_name_en,
      assignment.timepoint_name_ar,
      formUrl,
      optOutUrl,
      smsConfig.defaultLanguage
    );
    const result = await provider.send(assignment.contact_phone, message);
    db.prepare("UPDATE prom_assignments SET token_hash = ?, status = 'sent', sent_at = datetime('now') WHERE id = ?").run(
      sha256(rawToken),
      assignment.id
    );
    logAudit(db, assignment.tenant_id, null, 'proms_assignment_auto_sent', 'prom_assignment', assignment.id, { ok: result.ok });
    if (result.ok) sent += 1;
    else failed += 1;
  }

  // Reminder: sent, not completed, past the halfway point of the response window, no reminder
  // sent yet, still within the window (otherwise it's about to be expired below instead).
  const reminderRows = db
    .prepare(
      `SELECT pa.id, pa.token_hash, pa.due_date, pe.tenant_id, pe.contact_phone, pi.name_ar as instrument_name_ar,
              pi.name_en as instrument_name_en, pt.window_days
       FROM prom_assignments pa
       JOIN patient_episodes pe ON pe.id = pa.episode_id
       JOIN proms_instruments pi ON pi.id = pa.instrument_id
       JOIN pathway_timepoints pt ON pt.id = pa.timepoint_id
       WHERE pa.status = 'sent' AND pa.reminder_sent_at IS NULL AND pa.token_hash IS NOT NULL AND pe.opted_out_at IS NULL`
    )
    .all() as {
    id: string;
    token_hash: string;
    due_date: string;
    tenant_id: string;
    contact_phone: string | null;
    instrument_name_ar: string;
    instrument_name_en: string;
    window_days: number;
  }[];

  for (const assignment of reminderRows) {
    const dueTime = new Date(assignment.due_date).getTime();
    const windowMs = assignment.window_days * 24 * 60 * 60 * 1000;
    const elapsed = Date.now() - dueTime;
    if (elapsed < windowMs / 2 || elapsed >= windowMs || !assignment.contact_phone) continue;

    // The original raw token is never stored (only its hash, like every other token in this
    // system), so it can't be re-sent — the reminder rotates in a fresh token and invalidates
    // the original link rather than trying to recover it.
    const rawToken = uid();
    const formUrl = `${baseUrl}/p/${rawToken}`;
    const optOutUrl = `${formUrl}/opt-out`;
    const smsConfig = getTenantSmsConfig(db, assignment.tenant_id);
    const provider = createSmsProvider(smsConfig);
    const message = composePromsReminderMessage(
      assignment.instrument_name_ar,
      assignment.instrument_name_en,
      formUrl,
      optOutUrl,
      smsConfig.defaultLanguage
    );
    const result = await provider.send(assignment.contact_phone, message);
    db.prepare("UPDATE prom_assignments SET token_hash = ?, reminder_sent_at = datetime('now') WHERE id = ?").run(
      sha256(rawToken),
      assignment.id
    );
    if (result.ok) reminded += 1;
    logAudit(db, assignment.tenant_id, null, 'proms_assignment_reminder_sent', 'prom_assignment', assignment.id, { ok: result.ok });
  }

  const expireResult = db
    .prepare(
      `UPDATE prom_assignments SET status = 'expired'
       WHERE status IN ('scheduled', 'sent')
         AND EXISTS (
           SELECT 1 FROM pathway_timepoints pt
           WHERE pt.id = prom_assignments.timepoint_id
             AND datetime(prom_assignments.due_date, '+' || pt.window_days || ' days') < datetime('now')
         )`
    )
    .run();
  expired = Number(expireResult.changes);

  return { sent, failed, skipped, reminded, expired };
}

function departmentScopeFilter(req: Request, tableAlias: string): { clause: string; params: (string | number)[] } {
  if (req.user!.role === 'DepartmentManager' && req.user!.departmentId) {
    return { clause: `AND ${tableAlias}.department_id = ?`, params: [req.user!.departmentId] };
  }
  return { clause: '', params: [] };
}

export function createApi(db: Db, _sessionSecret: string, root: string): Router {
  const router = Router();
  router.use(attachSession(db));

  // -------------------------------------------------------------------------
  // Public survey (token is the identity; no auth)
  // -------------------------------------------------------------------------
  router.get('/public/surveys/:token', (req: Request, res: Response) => {
    const tokenHash = sha256(req.params.token);
    const invitation = db
      .prepare(
        `SELECT id, tenant_id, template_id, department_id, service_type, status, expires_at
         FROM survey_invitations WHERE token_hash = ?`
      )
      .get(tokenHash) as
      | { id: string; tenant_id: string; template_id: string; department_id: string; service_type: string; status: string; expires_at: string }
      | undefined;

    if (!invitation) {
      res.status(404).json({ error: 'invitation_not_found' });
      return;
    }
    if (invitation.status === 'completed') {
      res.status(410).json({ error: 'already_completed' });
      return;
    }
    if (new Date(invitation.expires_at).getTime() < Date.now()) {
      res.status(410).json({ error: 'expired' });
      return;
    }

    const template = db
      .prepare('SELECT name_ar, name_en FROM survey_templates WHERE id = ?')
      .get(invitation.template_id) as { name_ar: string; name_en: string };

    const questions = db
      .prepare(
        `SELECT q.id, q.code, q.text_ar, q.text_en, q.answer_type, q.depends_on_code
         FROM template_questions tq
         JOIN questions q ON q.id = tq.question_id
         WHERE tq.template_id = ?
         ORDER BY tq.sort_order`
      )
      .all(invitation.template_id) as {
      id: string;
      code: string;
      text_ar: string;
      text_en: string;
      answer_type: string;
      depends_on_code: string | null;
    }[];

    res.json({
      templateName: template.name_ar,
      templateNameEn: template.name_en,
      serviceType: invitation.service_type,
      defaultLanguage: getTenantSmsConfig(db, invitation.tenant_id).defaultLanguage,
      questions
    });
  });

  router.post('/public/surveys/:token/submit', express.json({ limit: '64kb' }), (req: Request, res: Response) => {
    const tokenHash = sha256(req.params.token);
    const invitation = db
      .prepare(
        `SELECT id, tenant_id, department_id, status, expires_at FROM survey_invitations WHERE token_hash = ?`
      )
      .get(tokenHash) as { id: string; tenant_id: string; department_id: string; status: string; expires_at: string } | undefined;

    if (!invitation) {
      res.status(404).json({ error: 'invitation_not_found' });
      return;
    }
    if (invitation.status === 'completed') {
      res.status(410).json({ error: 'already_completed' });
      return;
    }
    if (new Date(invitation.expires_at).getTime() < Date.now()) {
      res.status(410).json({ error: 'expired' });
      return;
    }

    const body = req.body as {
      answers?: { questionId: string; value: number }[];
      comment?: string;
      language?: string;
      contactOptIn?: boolean;
      contactPhone?: string;
    };
    if (!Array.isArray(body.answers)) {
      res.status(400).json({ error: 'invalid_answers' });
      return;
    }

    const validQuestionIds = new Set(
      (
        db
          .prepare(
            `SELECT q.id FROM template_questions tq
             JOIN questions q ON q.id = tq.question_id
             JOIN survey_invitations si ON si.template_id = tq.template_id
             WHERE si.id = ?`
          )
          .all(invitation.id) as { id: string }[]
      ).map((r) => r.id)
    );

    const responseId = uid();
    const submittedAt = new Date().toISOString();
    db.prepare(
      'INSERT INTO survey_responses (id, invitation_id, tenant_id, started_at, submitted_at, language, mode) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(responseId, invitation.id, invitation.tenant_id, submittedAt, submittedAt, body.language ?? 'ar', 'mobile');

    const insertAnswer = db.prepare('INSERT INTO answers (id, response_id, question_id, value_numeric) VALUES (?, ?, ?, ?)');
    for (const answer of body.answers) {
      if (!validQuestionIds.has(answer.questionId)) continue;
      if (typeof answer.value !== 'number' || !Number.isFinite(answer.value)) continue;
      insertAnswer.run(uid(), responseId, answer.questionId, answer.value);
    }

    if (body.comment && body.comment.trim().length > 0) {
      const rawText = body.comment.trim().slice(0, 2000);
      const redacted = redactPii(rawText);
      const analyzer = createDefaultAnalyzer();
      const analysis = analyzer.analyze(redacted);
      const commentId = uid();
      db.prepare(
        'INSERT INTO comments (id, response_id, tenant_id, department_id, raw_text, redacted_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(commentId, responseId, invitation.tenant_id, invitation.department_id, rawText, redacted, submittedAt);
      db.prepare(
        'INSERT INTO comment_analyses (id, comment_id, sentiment, category, severity, analyzer) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(uid(), commentId, analysis.sentiment, analysis.category, analysis.severity, analysis.analyzer);
      if (shouldAlert(analysis.severity)) {
        db.prepare('INSERT INTO comment_alerts (id, comment_id, tenant_id, severity) VALUES (?, ?, ?, ?)').run(
          uid(),
          commentId,
          invitation.tenant_id,
          analysis.severity
        );
      }
      if (analysis.severity >= 3) {
        const optIn = body.contactOptIn === true && !!body.contactPhone;
        db.prepare(
          `INSERT INTO service_recovery_cases
           (id, comment_id, tenant_id, department_id, status, opened_at, patient_contact_opt_in, patient_contact_phone)
           VALUES (?, ?, ?, ?, 'new', ?, ?, ?)`
        ).run(uid(), commentId, invitation.tenant_id, invitation.department_id, submittedAt, optIn ? 1 : 0, optIn ? body.contactPhone! : null);
      }
    }

    db.prepare("UPDATE survey_invitations SET status = 'completed' WHERE id = ?").run(invitation.id);
    res.status(201).json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // QR / Kiosk survey channel — public, reusable code (no expiry, no single-use)
  // -------------------------------------------------------------------------
  router.get('/public/kiosk/:code', (req: Request, res: Response) => {
    const kiosk = db
      .prepare('SELECT id, tenant_id, template_id, department_id, active FROM kiosk_links WHERE code = ?')
      .get(req.params.code) as { id: string; tenant_id: string; template_id: string; department_id: string; active: number } | undefined;
    if (!kiosk || !kiosk.active) {
      res.status(404).json({ error: 'kiosk_not_found' });
      return;
    }
    const template = db
      .prepare('SELECT name_ar, name_en, service_type FROM survey_templates WHERE id = ?')
      .get(kiosk.template_id) as { name_ar: string; name_en: string; service_type: string };
    const questions = db
      .prepare(
        `SELECT q.id, q.code, q.text_ar, q.text_en, q.answer_type, q.depends_on_code
         FROM template_questions tq
         JOIN questions q ON q.id = tq.question_id
         WHERE tq.template_id = ? AND q.active = 1
         ORDER BY tq.sort_order`
      )
      .all(kiosk.template_id) as {
      id: string;
      code: string;
      text_ar: string;
      text_en: string;
      answer_type: string;
      depends_on_code: string | null;
    }[];
    res.json({
      templateName: template.name_ar,
      templateNameEn: template.name_en,
      serviceType: template.service_type,
      defaultLanguage: getTenantSmsConfig(db, kiosk.tenant_id).defaultLanguage,
      questions
    });
  });

  router.post('/public/kiosk/:code/submit', express.json({ limit: '64kb' }), (req: Request, res: Response) => {
    const kiosk = db
      .prepare(
        'SELECT kl.id, kl.tenant_id, kl.template_id, kl.department_id, st.service_type FROM kiosk_links kl JOIN survey_templates st ON st.id = kl.template_id WHERE kl.code = ? AND kl.active = 1'
      )
      .get(req.params.code) as
      | { id: string; tenant_id: string; template_id: string; department_id: string; service_type: string }
      | undefined;
    if (!kiosk) {
      res.status(404).json({ error: 'kiosk_not_found' });
      return;
    }

    const body = req.body as { answers?: { questionId: string; value: number }[]; comment?: string; language?: string };
    if (!Array.isArray(body.answers)) {
      res.status(400).json({ error: 'invalid_answers' });
      return;
    }

    const validQuestionIds = new Set(
      (
        db
          .prepare('SELECT q.id FROM template_questions tq JOIN questions q ON q.id = tq.question_id WHERE tq.template_id = ?')
          .all(kiosk.template_id) as { id: string }[]
      ).map((r) => r.id)
    );

    const now = new Date().toISOString();
    const invitationId = uid();
    const farFutureExpiry = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO survey_invitations
       (id, tenant_id, template_id, department_id, service_type, token_hash, patient_phone_hash, channel, status, expires_at, sent_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'kiosk', 'completed', ?, ?, ?)`
    ).run(invitationId, kiosk.tenant_id, kiosk.template_id, kiosk.department_id, kiosk.service_type, sha256(uid()), sha256(uid()), farFutureExpiry, now, now);

    const responseId = uid();
    db.prepare(
      'INSERT INTO survey_responses (id, invitation_id, tenant_id, started_at, submitted_at, language, mode) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(responseId, invitationId, kiosk.tenant_id, now, now, body.language ?? 'ar', 'kiosk');

    const insertAnswer = db.prepare('INSERT INTO answers (id, response_id, question_id, value_numeric) VALUES (?, ?, ?, ?)');
    for (const answer of body.answers) {
      if (!validQuestionIds.has(answer.questionId)) continue;
      if (typeof answer.value !== 'number' || !Number.isFinite(answer.value)) continue;
      insertAnswer.run(uid(), responseId, answer.questionId, answer.value);
    }

    if (body.comment && body.comment.trim().length > 0) {
      const rawText = body.comment.trim().slice(0, 2000);
      const redacted = redactPii(rawText);
      const analyzer = createDefaultAnalyzer();
      const analysis = analyzer.analyze(redacted);
      const commentId = uid();
      db.prepare(
        'INSERT INTO comments (id, response_id, tenant_id, department_id, raw_text, redacted_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(commentId, responseId, kiosk.tenant_id, kiosk.department_id, rawText, redacted, now);
      db.prepare(
        'INSERT INTO comment_analyses (id, comment_id, sentiment, category, severity, analyzer) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(uid(), commentId, analysis.sentiment, analysis.category, analysis.severity, analysis.analyzer);
      if (shouldAlert(analysis.severity)) {
        db.prepare('INSERT INTO comment_alerts (id, comment_id, tenant_id, severity) VALUES (?, ?, ?, ?)').run(
          uid(),
          commentId,
          kiosk.tenant_id,
          analysis.severity
        );
      }
      if (analysis.severity >= 3) {
        db.prepare(
          `INSERT INTO service_recovery_cases (id, comment_id, tenant_id, department_id, status, opened_at)
           VALUES (?, ?, ?, ?, 'new', ?)`
        ).run(uid(), commentId, kiosk.tenant_id, kiosk.department_id, now);
      }
    }

    db.prepare('UPDATE kiosk_links SET response_count = response_count + 1 WHERE id = ?').run(kiosk.id);
    res.status(201).json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Tenant (hospital) self-registration — public
  // -------------------------------------------------------------------------
  router.post('/tenants/register', express.json({ limit: '8kb' }), (req: Request, res: Response) => {
    const body = req.body as {
      hospitalNameAr?: string;
      hospitalNameEn?: string;
      adminFullName?: string;
      adminEmail?: string;
      adminPassword?: string;
    };
    const hospitalNameAr = body.hospitalNameAr?.trim();
    const hospitalNameEn = body.hospitalNameEn?.trim();
    const adminFullName = body.adminFullName?.trim();
    const adminEmail = body.adminEmail?.toLowerCase().trim();
    const adminPassword = body.adminPassword;

    if (!hospitalNameAr || !hospitalNameEn || !adminFullName || !adminEmail || !adminPassword) {
      res.status(400).json({ error: 'missing_fields' });
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
      res.status(400).json({ error: 'invalid_email' });
      return;
    }
    if (adminPassword.length < 8) {
      res.status(400).json({ error: 'password_too_short' });
      return;
    }
    const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);
    if (existingUser) {
      res.status(409).json({ error: 'email_taken' });
      return;
    }

    const tenantId = uid();
    const slug = `${hospitalNameEn.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}-${tenantId.slice(0, 6)}`;
    db.prepare('INSERT INTO tenants (id, name_ar, name_en, slug) VALUES (?, ?, ?, ?)').run(tenantId, hospitalNameAr, hospitalNameEn, slug);

    const facilityId = uid();
    db.prepare('INSERT INTO facilities (id, tenant_id, name_ar, name_en) VALUES (?, ?, ?, ?)').run(
      facilityId,
      tenantId,
      'المبنى الرئيسي',
      'Main Building'
    );

    const adminId = uid();
    db.prepare(
      'INSERT INTO users (id, tenant_id, email, password_hash, role, department_id, full_name) VALUES (?, ?, ?, ?, ?, NULL, ?)'
    ).run(adminId, tenantId, adminEmail, hashPassword(adminPassword), 'SystemAdmin', adminFullName);

    const insertDepartment = db.prepare(
      'INSERT INTO departments (id, tenant_id, facility_id, name_ar, name_en, service_type) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const dept of DEFAULT_DEPARTMENTS) {
      insertDepartment.run(uid(), tenantId, facilityId, dept.nameAr, dept.nameEn, dept.service);
    }

    provisionTenantDefaults(db, root, tenantId);

    logAudit(db, tenantId, adminId, 'tenant_registered', 'tenant', tenantId, { hospitalNameEn });

    const { token, expiresAt } = createSession(db, adminId);
    setSessionCookie(res, token, expiresAt);
    res.status(201).json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------
  router.post('/auth/login', express.json({ limit: '8kb' }), (req: Request, res: Response) => {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password) {
      res.status(400).json({ error: 'missing_credentials' });
      return;
    }
    const user = db
      .prepare('SELECT id, password_hash, active FROM users WHERE email = ?')
      .get(email.toLowerCase().trim()) as { id: string; password_hash: string; active: number } | undefined;

    if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
      res.status(401).json({ error: 'invalid_credentials' });
      return;
    }
    const { token, expiresAt } = createSession(db, user.id);
    setSessionCookie(res, token, expiresAt);
    logAudit(db, null, user.id, 'login', 'session', null, null);
    res.json({ ok: true });
  });

  const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;

  router.post('/auth/forgot-password', express.json({ limit: '8kb' }), async (req: Request, res: Response) => {
    const { email } = req.body as { email?: string };
    if (!email) {
      res.status(400).json({ error: 'email_required' });
      return;
    }
    const user = db
      .prepare('SELECT id, email FROM users WHERE email = ? AND active = 1')
      .get(email.toLowerCase().trim()) as { id: string; email: string } | undefined;

    // Always respond the same way whether or not the account exists, so this endpoint can't be
    // used to discover which email addresses have accounts.
    if (user) {
      const rawToken = uid();
      const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS).toISOString();
      db.prepare('UPDATE users SET password_reset_token_hash = ?, password_reset_expires_at = ? WHERE id = ?').run(
        sha256(rawToken),
        expiresAt,
        user.id
      );
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const resetUrl = `${baseUrl}/reset-password/${rawToken}`;
      const { subject, body } = composePasswordResetEmail(resetUrl, 'ar');
      const provider = createEmailProvider();
      const result = await provider.send(user.email, subject, body);
      logAudit(db, null, user.id, 'password_reset_requested', 'user', user.id, { ok: result.ok });
    }
    res.json({ ok: true });
  });

  router.post('/auth/reset-password', express.json({ limit: '8kb' }), (req: Request, res: Response) => {
    const { token, newPassword } = req.body as { token?: string; newPassword?: string };
    if (!token || !newPassword) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    if (newPassword.length < 8) {
      res.status(400).json({ error: 'password_too_short' });
      return;
    }
    const user = db
      .prepare(
        `SELECT id FROM users WHERE password_reset_token_hash = ? AND password_reset_expires_at IS NOT NULL
         AND datetime(password_reset_expires_at) > datetime('now')`
      )
      .get(sha256(token)) as { id: string } | undefined;
    if (!user) {
      res.status(400).json({ error: 'invalid_or_expired_token' });
      return;
    }
    db.prepare(
      "UPDATE users SET password_hash = ?, password_reset_token_hash = NULL, password_reset_expires_at = NULL WHERE id = ?"
    ).run(hashPassword(newPassword), user.id);
    // A password reset should invalidate any session a stolen/leaked cookie might still hold.
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    logAudit(db, null, user.id, 'password_reset_completed', 'user', user.id, null);
    res.json({ ok: true });
  });

  router.post('/auth/logout', (req: Request, res: Response) => {
    const token = readSessionToken(req);
    if (token) destroySession(db, token);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  router.get('/auth/me', requireAuth, (req: Request, res: Response) => {
    res.json({ user: req.user });
  });

  // -------------------------------------------------------------------------
  // HIS/EMR webhook (public — authenticated via X-Api-Key, not a session)
  // -------------------------------------------------------------------------
  router.post('/webhooks/invitations', express.json({ limit: '256kb' }), async (req: Request, res: Response) => {
    const apiKey = req.get('X-Api-Key');
    if (!apiKey) {
      res.status(401).json({ error: 'missing_api_key' });
      return;
    }
    const integration = db
      .prepare('SELECT tenant_id FROM tenant_integrations WHERE his_webhook_key_hash = ? AND his_webhook_enabled = 1')
      .get(sha256(apiKey)) as { tenant_id: string } | undefined;
    if (!integration) {
      res.status(401).json({ error: 'invalid_api_key' });
      return;
    }
    const tenantId = integration.tenant_id;

    const { rows, templateId, departmentId, channel } = req.body as {
      rows?: { phone: string }[];
      templateId?: string;
      departmentId?: string;
      channel?: 'sms' | 'whatsapp';
    };
    if (!Array.isArray(rows) || rows.length === 0 || !templateId || !departmentId) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const template = db
      .prepare('SELECT service_type, name_ar, name_en FROM survey_templates WHERE id = ? AND tenant_id = ?')
      .get(templateId, tenantId) as { service_type: string; name_ar: string; name_en: string } | undefined;
    const department = db.prepare('SELECT id FROM departments WHERE id = ? AND tenant_id = ?').get(departmentId, tenantId);
    if (!template || !department) {
      res.status(404).json({ error: 'template_or_department_not_found' });
      return;
    }

    const smsConfig = getTenantSmsConfig(db, tenantId);
    const provider = createSmsProvider(smsConfig);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const effectiveChannel = channel ?? 'sms';

    const insert = db.prepare(
      `INSERT INTO survey_invitations
       (id, tenant_id, template_id, department_id, service_type, token_hash, patient_phone_hash, channel, status, expires_at, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const now = new Date().toISOString();
    const expires = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    let created = 0;
    let sent = 0;
    let skipped = 0;
    for (const row of rows) {
      if (!row.phone) continue;
      const phoneHash = sha256(row.phone);
      if (!isEligibleForInvitation(db, tenantId, phoneHash).eligible) {
        skipped += 1;
        continue;
      }
      const rawToken = uid();
      const surveyUrl = `${baseUrl}/s/${rawToken}`;
      const message = composeInvitationMessage(template.name_ar, template.name_en, surveyUrl, smsConfig.defaultLanguage);
      const result = await provider.send(row.phone, message);
      if (result.ok) sent += 1;
      insert.run(
        uid(),
        tenantId,
        templateId,
        departmentId,
        template.service_type,
        sha256(rawToken),
        phoneHash,
        effectiveChannel,
        result.ok ? 'sent' : 'pending',
        expires,
        now
      );
      created += 1;
    }
    logAudit(db, tenantId, null, 'invitations_webhook_created', 'survey_invitation', null, { count: created, sent, skipped });
    res.status(201).json({ created, sent, skipped });
  });

  // Same HIS integration key as /webhooks/invitations — lets the hospital's own system start
  // a PROMs care-pathway episode automatically (e.g. when a knee-replacement surgery is
  // documented), instead of a staff member re-keying it into the dashboard.
  router.post('/webhooks/episodes', express.json({ limit: '8kb' }), (req: Request, res: Response) => {
    const apiKey = req.get('X-Api-Key');
    if (!apiKey) {
      res.status(401).json({ error: 'missing_api_key' });
      return;
    }
    const integration = db
      .prepare('SELECT tenant_id FROM tenant_integrations WHERE his_webhook_key_hash = ? AND his_webhook_enabled = 1')
      .get(sha256(apiKey)) as { tenant_id: string } | undefined;
    if (!integration) {
      res.status(401).json({ error: 'invalid_api_key' });
      return;
    }
    const result = createEpisode(db, integration.tenant_id, req.body);
    if (!result.ok) {
      res.status(result.error.endsWith('not_found') ? 404 : 400).json({ error: result.error });
      return;
    }
    logAudit(db, integration.tenant_id, null, 'episode_created_via_webhook', 'patient_episode', result.id, null);
    res.status(201).json({ id: result.id });
  });

  // Everything below requires an authenticated session.
  // -------------------------------------------------------------------------
  // PROMs — public patient-facing form (free instruments only; licensed
  // instruments are never administered digitally until licensing is documented)
  // -------------------------------------------------------------------------
  router.get('/public/proms/:token', (req: Request, res: Response) => {
    const assignment = db
      .prepare(
        `SELECT pa.id, pa.status, pa.due_date, pa.instrument_id, pi.code as instrument_code, pi.name_ar as instrument_name_ar,
                pi.name_en as instrument_name_en, pi.license_status, pt.window_days, pe.opted_out_at, pe.tenant_id
         FROM prom_assignments pa
         JOIN proms_instruments pi ON pi.id = pa.instrument_id
         JOIN pathway_timepoints pt ON pt.id = pa.timepoint_id
         JOIN patient_episodes pe ON pe.id = pa.episode_id
         WHERE pa.token_hash = ?`
      )
      .get(sha256(req.params.token)) as
      | {
          id: string;
          status: string;
          due_date: string;
          instrument_id: string;
          instrument_code: string;
          instrument_name_ar: string;
          instrument_name_en: string;
          license_status: string;
          window_days: number;
          opted_out_at: string | null;
          tenant_id: string;
        }
      | undefined;
    if (!assignment) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (assignment.license_status !== 'free') {
      res.status(409).json({ error: 'instrument_requires_manual_administration' });
      return;
    }
    if (assignment.opted_out_at) {
      res.status(410).json({ error: 'opted_out' });
      return;
    }
    if (assignment.status === 'completed') {
      res.status(410).json({ error: 'already_completed' });
      return;
    }
    if (assignment.status === 'expired' || isPromsWindowExpired(assignment.due_date, assignment.window_days)) {
      res.status(410).json({ error: 'link_expired' });
      return;
    }
    const items = db
      .prepare('SELECT code, text_ar, text_en, scale_max FROM proms_instrument_items WHERE instrument_id = ? ORDER BY sort_order')
      .all(assignment.instrument_id) as { code: string; text_ar: string; text_en: string; scale_max: number }[];
    res.json({
      instrumentName: assignment.instrument_name_ar,
      instrumentNameEn: assignment.instrument_name_en,
      defaultLanguage: getTenantSmsConfig(db, assignment.tenant_id).defaultLanguage,
      items: items.map((i) => ({ code: i.code, textAr: i.text_ar, textEn: i.text_en, scaleMax: i.scale_max }))
    });
  });

  router.post('/public/proms/:token/submit', express.json({ limit: '16kb' }), (req: Request, res: Response) => {
    const assignment = db
      .prepare(
        `SELECT pa.id, pa.episode_id, pa.timepoint_id, pa.instrument_id, pa.status, pa.due_date, pi.code as instrument_code,
                pi.license_status, pi.higher_is_better, pi.mcid_threshold, pt.window_days, pe.tenant_id, pe.opted_out_at
         FROM prom_assignments pa
         JOIN proms_instruments pi ON pi.id = pa.instrument_id
         JOIN pathway_timepoints pt ON pt.id = pa.timepoint_id
         JOIN patient_episodes pe ON pe.id = pa.episode_id
         WHERE pa.token_hash = ?`
      )
      .get(sha256(req.params.token)) as
      | {
          id: string;
          episode_id: string;
          timepoint_id: string;
          instrument_id: string;
          status: string;
          due_date: string;
          instrument_code: string;
          license_status: string;
          higher_is_better: number;
          mcid_threshold: number;
          window_days: number;
          tenant_id: string;
          opted_out_at: string | null;
        }
      | undefined;
    if (!assignment) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (assignment.license_status !== 'free') {
      res.status(409).json({ error: 'instrument_requires_manual_administration' });
      return;
    }
    if (assignment.opted_out_at) {
      res.status(410).json({ error: 'opted_out' });
      return;
    }
    if (assignment.status === 'completed') {
      res.status(410).json({ error: 'already_completed' });
      return;
    }
    if (assignment.status === 'expired' || isPromsWindowExpired(assignment.due_date, assignment.window_days)) {
      res.status(410).json({ error: 'link_expired' });
      return;
    }

    const definition = resolveInstrumentDefinition(assignment.instrument_code, assignment.higher_is_better, assignment.mcid_threshold);

    const body = req.body as { answers?: { code: string; value: number }[] };
    if (!Array.isArray(body.answers)) {
      res.status(400).json({ error: 'invalid_answers' });
      return;
    }
    const itemDefs = db
      .prepare('SELECT code, reverse_scored, scale_max FROM proms_instrument_items WHERE instrument_id = ?')
      .all(assignment.instrument_id) as { code: string; reverse_scored: number; scale_max: number }[];
    const itemDefByCode = new Map(itemDefs.map((i) => [i.code, i]));

    const items: InstrumentItemValue[] = [];
    for (const answer of body.answers) {
      const def = itemDefByCode.get(answer.code);
      if (!def || typeof answer.value !== 'number' || !Number.isFinite(answer.value)) continue;
      items.push({ code: answer.code, value: answer.value, reverseScored: !!def.reverse_scored, scaleMax: def.scale_max });
    }
    if (items.length < itemDefs.length) {
      res.status(400).json({ error: 'incomplete_answers' });
      return;
    }

    // Baseline = the score recorded at this episode's earliest timepoint for the same
    // instrument (null if this submission IS the baseline).
    const baselineRow = db
      .prepare(
        `SELECT ps.raw_score
         FROM prom_scores ps
         JOIN prom_assignments pa2 ON pa2.id = ps.assignment_id
         JOIN pathway_timepoints pt ON pt.id = pa2.timepoint_id
         WHERE pa2.episode_id = ? AND pa2.instrument_id = ?
         ORDER BY pt.sort_order ASC LIMIT 1`
      )
      .get(assignment.episode_id, assignment.instrument_id) as { raw_score: number } | undefined;

    const currentTimepointSort = (
      db.prepare('SELECT sort_order FROM pathway_timepoints WHERE id = ?').get(assignment.timepoint_id) as { sort_order: number }
    ).sort_order;
    const earliestSort = (
      db
        .prepare(
          `SELECT MIN(pt.sort_order) as s FROM prom_assignments pa2 JOIN pathway_timepoints pt ON pt.id = pa2.timepoint_id
           WHERE pa2.episode_id = ? AND pa2.instrument_id = ?`
        )
        .get(assignment.episode_id, assignment.instrument_id) as { s: number }
    ).s;
    const isBaseline = currentTimepointSort === earliestSort;

    const result = scoreInstrument(definition, items, isBaseline ? null : (baselineRow?.raw_score ?? null));

    db.prepare(
      'INSERT INTO prom_scores (id, assignment_id, instrument_id, raw_score, band, baseline_score, delta, mcid_met) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      uid(),
      assignment.id,
      assignment.instrument_id,
      result.raw,
      result.band,
      result.baseline,
      result.delta,
      result.mcidMet === null ? null : result.mcidMet ? 1 : 0
    );
    db.prepare("UPDATE prom_assignments SET status = 'completed' WHERE id = ?").run(assignment.id);

    res.status(201).json({ ok: true, raw: result.raw, band: result.band, delta: result.delta, mcidMet: result.mcidMet });
  });

  // Patient-initiated withdrawal from a PROMs follow-up program — reachable from the opt-out
  // link included in every PROMs SMS. Cancels every remaining assignment on the episode so no
  // further follow-up messages go out, without requiring the patient to log in anywhere.
  router.post('/public/proms/:token/opt-out', (req: Request, res: Response) => {
    const assignment = db
      .prepare('SELECT pa.episode_id FROM prom_assignments pa WHERE pa.token_hash = ?')
      .get(sha256(req.params.token)) as { episode_id: string } | undefined;
    if (!assignment) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    db.prepare("UPDATE patient_episodes SET opted_out_at = COALESCE(opted_out_at, datetime('now')) WHERE id = ?").run(assignment.episode_id);
    db.prepare("UPDATE prom_assignments SET status = 'cancelled' WHERE episode_id = ? AND status IN ('scheduled', 'sent')").run(
      assignment.episode_id
    );
    res.json({ ok: true });
  });

  router.use(requireAuth);

  // -------------------------------------------------------------------------
  // Departments / question bank / templates (read-mostly reference data)
  // -------------------------------------------------------------------------
  router.get('/departments', (req: Request, res: Response) => {
    const includeInactive = req.query.includeInactive === '1' && req.user!.role === 'SystemAdmin';
    const rows = db
      .prepare(
        `SELECT id, name_ar, name_en, service_type, active FROM departments
         WHERE tenant_id = ? ${includeInactive ? '' : 'AND active = 1'} ORDER BY service_type`
      )
      .all(req.user!.tenantId);
    res.json({ departments: rows });
  });

  router.post('/departments', requireRole('SystemAdmin'), express.json({ limit: '8kb' }), (req: Request, res: Response) => {
    const { nameAr, nameEn, serviceType } = req.body as { nameAr?: string; nameEn?: string; serviceType?: ServiceType };
    if (!nameAr || !nameEn || !serviceType) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const facility = db.prepare('SELECT id FROM facilities WHERE tenant_id = ? LIMIT 1').get(req.user!.tenantId) as
      | { id: string }
      | undefined;
    if (!facility) {
      res.status(500).json({ error: 'no_facility' });
      return;
    }
    const id = uid();
    db.prepare('INSERT INTO departments (id, tenant_id, facility_id, name_ar, name_en, service_type) VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      req.user!.tenantId,
      facility.id,
      nameAr,
      nameEn,
      serviceType
    );
    logAudit(db, req.user!.tenantId, req.user!.id, 'department_created', 'department', id, { nameAr, serviceType });
    res.status(201).json({ id });
  });

  router.patch('/departments/:id', requireRole('SystemAdmin'), express.json({ limit: '8kb' }), (req: Request, res: Response) => {
    const existing = db.prepare('SELECT id FROM departments WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user!.tenantId);
    if (!existing) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const { nameAr, nameEn, active } = req.body as { nameAr?: string; nameEn?: string; active?: boolean };
    if (nameAr !== undefined) db.prepare('UPDATE departments SET name_ar = ? WHERE id = ?').run(nameAr, req.params.id);
    if (nameEn !== undefined) db.prepare('UPDATE departments SET name_en = ? WHERE id = ?').run(nameEn, req.params.id);
    if (active !== undefined) db.prepare('UPDATE departments SET active = ? WHERE id = ?').run(active ? 1 : 0, req.params.id);
    logAudit(db, req.user!.tenantId, req.user!.id, 'department_updated', 'department', req.params.id, req.body);
    res.json({ ok: true });
  });

  router.delete('/departments/:id', requireRole('SystemAdmin'), (req: Request, res: Response) => {
    const existing = db.prepare('SELECT id FROM departments WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user!.tenantId);
    if (!existing) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    db.prepare('UPDATE departments SET active = 0 WHERE id = ?').run(req.params.id);
    logAudit(db, req.user!.tenantId, req.user!.id, 'department_deactivated', 'department', req.params.id, null);
    res.json({ ok: true });
  });

  router.get('/question-bank', (req: Request, res: Response) => {
    const includeInactive = req.query.includeInactive === '1' && req.user!.role === 'SystemAdmin';
    const domains = db
      .prepare(
        `SELECT id, code, name_ar, name_en, service_type, benchmark_top_box_percent, active FROM question_domains
         WHERE tenant_id = ? ${includeInactive ? '' : 'AND active = 1'}`
      )
      .all(req.user!.tenantId);
    const questions = db
      .prepare(
        `SELECT id, code, domain_id, text_ar, text_en, answer_type, service_type, requires_alert, active FROM questions
         WHERE tenant_id = ? ${includeInactive ? '' : 'AND active = 1'} ORDER BY sort_order`
      )
      .all(req.user!.tenantId);
    res.json({ domains, questions });
  });

  router.post('/question-bank/domains', requireRole('SystemAdmin'), express.json({ limit: '8kb' }), (req: Request, res: Response) => {
    const { code, nameAr, nameEn, serviceType, benchmarkTopBoxPercent } = req.body as {
      code?: string;
      nameAr?: string;
      nameEn?: string;
      serviceType?: ServiceType;
      benchmarkTopBoxPercent?: number;
    };
    if (!code || !nameAr || !nameEn || !serviceType) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const id = uid();
    try {
      db.prepare(
        'INSERT INTO question_domains (id, tenant_id, code, name_ar, name_en, service_type, benchmark_top_box_percent) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(id, req.user!.tenantId, code, nameAr, nameEn, serviceType, benchmarkTopBoxPercent ?? 75.0);
    } catch {
      res.status(409).json({ error: 'code_already_exists' });
      return;
    }
    logAudit(db, req.user!.tenantId, req.user!.id, 'domain_created', 'question_domain', id, { code });
    res.status(201).json({ id });
  });

  router.patch(
    '/question-bank/domains/:id',
    requireRole('SystemAdmin'),
    express.json({ limit: '8kb' }),
    (req: Request, res: Response) => {
      const existing = db.prepare('SELECT id FROM question_domains WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user!.tenantId);
      if (!existing) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const { nameAr, nameEn, benchmarkTopBoxPercent, active } = req.body as {
        nameAr?: string;
        nameEn?: string;
        benchmarkTopBoxPercent?: number;
        active?: boolean;
      };
      if (nameAr !== undefined) db.prepare('UPDATE question_domains SET name_ar = ? WHERE id = ?').run(nameAr, req.params.id);
      if (nameEn !== undefined) db.prepare('UPDATE question_domains SET name_en = ? WHERE id = ?').run(nameEn, req.params.id);
      if (benchmarkTopBoxPercent !== undefined)
        db.prepare('UPDATE question_domains SET benchmark_top_box_percent = ? WHERE id = ?').run(benchmarkTopBoxPercent, req.params.id);
      if (active !== undefined) db.prepare('UPDATE question_domains SET active = ? WHERE id = ?').run(active ? 1 : 0, req.params.id);
      logAudit(db, req.user!.tenantId, req.user!.id, 'domain_updated', 'question_domain', req.params.id, req.body);
      res.json({ ok: true });
    }
  );

  router.post('/question-bank/questions', requireRole('SystemAdmin'), express.json({ limit: '8kb' }), (req: Request, res: Response) => {
    const { code, domainId, textAr, textEn, type, requiresAlert, dependsOnCode } = req.body as {
      code?: string;
      domainId?: string;
      textAr?: string;
      textEn?: string;
      type?: AnswerType;
      requiresAlert?: boolean;
      dependsOnCode?: string;
    };
    if (!code || !domainId || !textAr || !textEn || !type) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const domain = db.prepare('SELECT id, service_type FROM question_domains WHERE id = ? AND tenant_id = ?').get(domainId, req.user!.tenantId) as
      | { id: string; service_type: ServiceType }
      | undefined;
    if (!domain) {
      res.status(404).json({ error: 'domain_not_found' });
      return;
    }
    const template = db
      .prepare('SELECT id FROM survey_templates WHERE tenant_id = ? AND service_type = ?')
      .get(req.user!.tenantId, domain.service_type) as { id: string } | undefined;

    const id = uid();
    const nextSortOrder = (
      db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 as n FROM questions WHERE tenant_id = ?').get(req.user!.tenantId) as { n: number }
    ).n;
    try {
      db.prepare(
        `INSERT INTO questions
         (id, tenant_id, code, domain_id, text_ar, text_en, answer_type, service_type, requires_alert, sort_order, depends_on_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, req.user!.tenantId, code, domainId, textAr, textEn, type, domain.service_type, requiresAlert ? 1 : 0, nextSortOrder, dependsOnCode ?? null);
    } catch {
      res.status(409).json({ error: 'code_already_exists' });
      return;
    }
    if (template) {
      const nextTemplateSortOrder = (
        db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 as n FROM template_questions WHERE template_id = ?').get(template.id) as {
          n: number;
        }
      ).n;
      db.prepare('INSERT INTO template_questions (id, template_id, question_id, sort_order) VALUES (?, ?, ?, ?)').run(
        uid(),
        template.id,
        id,
        nextTemplateSortOrder
      );
    }
    logAudit(db, req.user!.tenantId, req.user!.id, 'question_created', 'question', id, { code });
    res.status(201).json({ id });
  });

  router.patch(
    '/question-bank/questions/:id',
    requireRole('SystemAdmin'),
    express.json({ limit: '8kb' }),
    (req: Request, res: Response) => {
      const existing = db.prepare('SELECT id FROM questions WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user!.tenantId);
      if (!existing) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const { textAr, textEn, requiresAlert, active } = req.body as {
        textAr?: string;
        textEn?: string;
        requiresAlert?: boolean;
        active?: boolean;
      };
      if (textAr !== undefined) db.prepare('UPDATE questions SET text_ar = ? WHERE id = ?').run(textAr, req.params.id);
      if (textEn !== undefined) db.prepare('UPDATE questions SET text_en = ? WHERE id = ?').run(textEn, req.params.id);
      if (requiresAlert !== undefined) db.prepare('UPDATE questions SET requires_alert = ? WHERE id = ?').run(requiresAlert ? 1 : 0, req.params.id);
      if (active !== undefined) db.prepare('UPDATE questions SET active = ? WHERE id = ?').run(active ? 1 : 0, req.params.id);
      logAudit(db, req.user!.tenantId, req.user!.id, 'question_updated', 'question', req.params.id, req.body);
      res.json({ ok: true });
    }
  );

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------
  const VALID_ROLES: Role[] = ['SystemAdmin', 'QualityManager', 'DepartmentManager', 'ExecutiveViewer'];

  router.get('/users', requireRole('SystemAdmin'), (req: Request, res: Response) => {
    const rows = db
      .prepare(
        `SELECT id, email, role, department_id, full_name, active FROM users WHERE tenant_id = ? ORDER BY full_name`
      )
      .all(req.user!.tenantId);
    res.json({ users: rows });
  });

  router.post('/users', requireRole('SystemAdmin'), express.json({ limit: '8kb' }), (req: Request, res: Response) => {
    const { email, password, role, departmentId, fullName } = req.body as {
      email?: string;
      password?: string;
      role?: Role;
      departmentId?: string | null;
      fullName?: string;
    };
    if (!email || !password || !role || !fullName || !VALID_ROLES.includes(role)) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: 'password_too_short' });
      return;
    }
    if (role === 'DepartmentManager' && !departmentId) {
      res.status(400).json({ error: 'department_required_for_department_manager' });
      return;
    }
    const id = uid();
    try {
      db.prepare('INSERT INTO users (id, tenant_id, email, password_hash, role, department_id, full_name) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        id,
        req.user!.tenantId,
        email.toLowerCase().trim(),
        hashPassword(password),
        role,
        role === 'DepartmentManager' ? (departmentId ?? null) : null,
        fullName
      );
    } catch {
      res.status(409).json({ error: 'email_already_used' });
      return;
    }
    logAudit(db, req.user!.tenantId, req.user!.id, 'user_created', 'user', id, { email, role });
    res.status(201).json({ id });
  });

  router.patch('/users/:id', requireRole('SystemAdmin'), express.json({ limit: '8kb' }), (req: Request, res: Response) => {
    const existing = db.prepare('SELECT id FROM users WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user!.tenantId);
    if (!existing) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const { role, departmentId, fullName, active, password } = req.body as {
      role?: Role;
      departmentId?: string | null;
      fullName?: string;
      active?: boolean;
      password?: string;
    };
    if (active === false && req.params.id === req.user!.id) {
      res.status(400).json({ error: 'cannot_deactivate_self' });
      return;
    }
    if (role !== undefined) {
      if (!VALID_ROLES.includes(role)) {
        res.status(400).json({ error: 'invalid_role' });
        return;
      }
      db.prepare('UPDATE users SET role = ?, department_id = ? WHERE id = ?').run(
        role,
        role === 'DepartmentManager' ? (departmentId ?? null) : null,
        req.params.id
      );
    } else if (departmentId !== undefined) {
      db.prepare('UPDATE users SET department_id = ? WHERE id = ?').run(departmentId, req.params.id);
    }
    if (fullName !== undefined) db.prepare('UPDATE users SET full_name = ? WHERE id = ?').run(fullName, req.params.id);
    if (active !== undefined) db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, req.params.id);
    if (password) {
      if (password.length < 8) {
        res.status(400).json({ error: 'password_too_short' });
        return;
      }
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), req.params.id);
      // Force the affected user to log in again with the new password on every device.
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.params.id);
    }
    logAudit(db, req.user!.tenantId, req.user!.id, 'user_updated', 'user', req.params.id, { role, active, fullNameChanged: fullName !== undefined });
    res.json({ ok: true });
  });

  router.delete('/users/:id', requireRole('SystemAdmin'), (req: Request, res: Response) => {
    if (req.params.id === req.user!.id) {
      res.status(400).json({ error: 'cannot_deactivate_self' });
      return;
    }
    const existing = db.prepare('SELECT id FROM users WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user!.tenantId);
    if (!existing) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(req.params.id);
    logAudit(db, req.user!.tenantId, req.user!.id, 'user_deactivated', 'user', req.params.id, null);
    res.json({ ok: true });
  });

  router.get('/templates', (req: Request, res: Response) => {
    const templates = db
      .prepare('SELECT id, name_ar, name_en, service_type, active FROM survey_templates WHERE tenant_id = ?')
      .all(req.user!.tenantId) as { id: string; name_ar: string; name_en: string; service_type: string; active: number }[];
    const withQuestions = templates.map((t) => ({
      ...t,
      questions: db
        .prepare(
          `SELECT q.id, q.code, q.text_ar, q.text_en, q.answer_type, q.depends_on_code
           FROM template_questions tq JOIN questions q ON q.id = tq.question_id
           WHERE tq.template_id = ? AND q.active = 1 ORDER BY tq.sort_order`
        )
        .all(t.id)
    }));
    res.json({ templates: withQuestions });
  });

  // -------------------------------------------------------------------------
  // Reports (PREMs)
  // -------------------------------------------------------------------------
  router.get('/reports/scores', (req: Request, res: Response) => {
    const serviceType = req.query.serviceType as ServiceType | undefined;
    const departmentId = req.query.departmentId as string | undefined;

    if (req.user!.role === 'DepartmentManager' && departmentId && departmentId !== req.user!.departmentId) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const effectiveDeptId = req.user!.role === 'DepartmentManager' ? req.user!.departmentId : departmentId;

    const domains = db
      .prepare(
        `SELECT id, code, name_ar, name_en, service_type, benchmark_top_box_percent FROM question_domains
         WHERE tenant_id = ? AND active = 1 AND (? IS NULL OR service_type = ?)`
      )
      .all(req.user!.tenantId, serviceType ?? null, serviceType ?? null) as {
      id: string;
      code: string;
      name_ar: string;
      name_en: string;
      service_type: string;
      benchmark_top_box_percent: number;
    }[];

    const results = domains.map((domain) => {
      const questions = db
        .prepare('SELECT id, code, text_ar, text_en, answer_type FROM questions WHERE domain_id = ? AND active = 1 ORDER BY sort_order')
        .all(domain.id) as { id: string; code: string; text_ar: string; text_en: string; answer_type: AnswerType }[];

      const questionScores = questions.map((q) => {
        const values = (
          db
            .prepare(
              `SELECT a.value_numeric as v FROM answers a
               JOIN survey_responses r ON r.id = a.response_id
               WHERE a.question_id = ? AND r.tenant_id = ?
               ${effectiveDeptId ? 'AND EXISTS (SELECT 1 FROM survey_invitations si WHERE si.id = r.invitation_id AND si.department_id = ?)' : ''}`
            )
            .all(...(effectiveDeptId ? [q.id, req.user!.tenantId, effectiveDeptId] : [q.id, req.user!.tenantId])) as { v: number }[]
        ).map((r) => r.v);

        if (q.answer_type === 'nps') {
          const nps = scoreNps(values);
          return { ...q, n: nps.n, mean: null, topBoxPercent: null, npsScore: nps.score, yesPercent: null };
        }
        if (q.answer_type === 'yesno') {
          const yesNo = scoreYesNo(values);
          return { ...q, n: yesNo.n, mean: null, topBoxPercent: null, npsScore: null, yesPercent: yesNo.yesPercent };
        }
        const score = scoreQuestion(q.id, values);
        return { ...q, ...score, npsScore: null, yesPercent: null };
      });

      const allDomainValues = questionScores
        .filter((q) => q.answer_type !== 'nps' && q.answer_type !== 'yesno')
        .flatMap((q) => {
          const values = (
            db
              .prepare(
                `SELECT a.value_numeric as v FROM answers a
                 JOIN survey_responses r ON r.id = a.response_id
                 WHERE a.question_id = ? AND r.tenant_id = ?
                 ${effectiveDeptId ? 'AND EXISTS (SELECT 1 FROM survey_invitations si WHERE si.id = r.invitation_id AND si.department_id = ?)' : ''}`
              )
              .all(...(effectiveDeptId ? [q.id, req.user!.tenantId, effectiveDeptId] : [q.id, req.user!.tenantId])) as { v: number }[]
          ).map((r) => r.v);
          return values;
        });

      const domainScore = scoreDomain(domain.id, allDomainValues, domain.benchmark_top_box_percent);
      return {
        domain: { id: domain.id, code: domain.code, nameAr: domain.name_ar, nameEn: domain.name_en, serviceType: domain.service_type },
        score: domainScore,
        questions: questionScores
      };
    });

    res.json({
      smallSampleThreshold: SMALL_SAMPLE_THRESHOLD,
      reliableSampleThreshold: RELIABLE_SAMPLE_THRESHOLD,
      publicReportingSampleThreshold: PUBLIC_REPORTING_SAMPLE_THRESHOLD,
      domains: results
    });
  });

  const TREND_PERIOD_EXPR: Record<'month' | 'quarter' | 'half' | 'year', string> = {
    month: "strftime('%Y-%m', r.submitted_at)",
    quarter: "strftime('%Y', r.submitted_at) || '-Q' || ((CAST(strftime('%m', r.submitted_at) AS INTEGER) - 1) / 3 + 1)",
    half: "strftime('%Y', r.submitted_at) || '-H' || ((CAST(strftime('%m', r.submitted_at) AS INTEGER) - 1) / 6 + 1)",
    year: "strftime('%Y', r.submitted_at)"
  };

  router.get('/reports/trend', (req: Request, res: Response) => {
    const serviceType = req.query.serviceType as ServiceType | undefined;
    const departmentId = req.user!.role === 'DepartmentManager' ? req.user!.departmentId : (req.query.departmentId as string | undefined);
    const periodParam = req.query.period as string | undefined;
    const period = periodParam && periodParam in TREND_PERIOD_EXPR ? (periodParam as keyof typeof TREND_PERIOD_EXPR) : 'month';
    const periodExpr = TREND_PERIOD_EXPR[period];

    const rows = db
      .prepare(
        `SELECT ${periodExpr} as period, AVG(a.value_numeric) as mean,
                AVG(CASE WHEN a.value_numeric >= 5 THEN 100.0 ELSE 0.0 END) as topBoxPercent,
                COUNT(*) as n
         FROM answers a
         JOIN survey_responses r ON r.id = a.response_id
         JOIN questions q ON q.id = a.question_id
         JOIN survey_invitations si ON si.id = r.invitation_id
         WHERE r.tenant_id = ? AND q.answer_type = 'likert5'
         ${serviceType ? 'AND q.service_type = ?' : ''}
         ${departmentId ? 'AND si.department_id = ?' : ''}
         GROUP BY period ORDER BY period`
      )
      .all(
        ...[req.user!.tenantId, ...(serviceType ? [serviceType] : []), ...(departmentId ? [departmentId] : [])]
      ) as { period: string; mean: number; topBoxPercent: number; n: number }[];

    res.json({
      period,
      trend: rows.map((r) => ({ ...r, mean: round2(r.mean), topBoxPercent: round2(r.topBoxPercent) }))
    });
  });

  // -------------------------------------------------------------------------
  // Comments Intelligence + Service Recovery
  // -------------------------------------------------------------------------
  router.get('/comments', (req: Request, res: Response) => {
    const { clause, params } = departmentScopeFilter(req, 'c');
    const category = req.query.category as string | undefined;
    const severityMin = req.query.severityMin ? Number(req.query.severityMin) : undefined;
    const unacknowledgedOnly = req.query.unacknowledgedOnly === 'true';

    const rows = db
      .prepare(
        `SELECT c.id, c.department_id, c.redacted_text, c.created_at,
                ca.sentiment, ca.category, ca.severity,
                src.id as case_id, src.status as case_status, src.assigned_to, src.resolution_notes,
                al.id as alert_id, al.acknowledged as alert_acknowledged
         FROM comments c
         JOIN comment_analyses ca ON ca.comment_id = c.id
         LEFT JOIN service_recovery_cases src ON src.comment_id = c.id
         LEFT JOIN comment_alerts al ON al.comment_id = c.id
         WHERE c.tenant_id = ? ${clause}
         ${category ? 'AND ca.category = ?' : ''}
         ${severityMin !== undefined ? 'AND ca.severity >= ?' : ''}
         ${unacknowledgedOnly ? "AND al.id IS NOT NULL AND al.acknowledged = 0" : ''}
         ORDER BY c.created_at DESC
         LIMIT 200`
      )
      .all(
        ...[req.user!.tenantId, ...params, ...(category ? [category] : []), ...(severityMin !== undefined ? [severityMin] : [])]
      );
    res.json({ comments: rows });
  });

  router.post(
    '/comments/:id/acknowledge',
    requireRole('SystemAdmin', 'QualityManager', 'DepartmentManager'),
    (req: Request, res: Response) => {
      const comment = db.prepare('SELECT id, tenant_id, department_id FROM comments WHERE id = ?').get(req.params.id) as
        | { id: string; tenant_id: string; department_id: string }
        | undefined;
      if (!comment || comment.tenant_id !== req.user!.tenantId) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (req.user!.role === 'DepartmentManager' && comment.department_id !== req.user!.departmentId) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      db.prepare('UPDATE comment_alerts SET acknowledged = 1 WHERE comment_id = ?').run(comment.id);
      logAudit(db, req.user!.tenantId, req.user!.id, 'comment_alert_acknowledged', 'comment', comment.id, null);
      res.json({ ok: true });
    }
  );

  router.get(
    '/alerts/summary',
    requireRole('SystemAdmin', 'QualityManager', 'DepartmentManager'),
    (req: Request, res: Response) => {
      const commentScope = departmentScopeFilter(req, 'c');
      const caseScope = departmentScopeFilter(req, 'src');
      const unacknowledgedComments = (
        db
          .prepare(
            `SELECT COUNT(*) as n FROM comment_alerts al
             JOIN comments c ON c.id = al.comment_id
             WHERE c.tenant_id = ? ${commentScope.clause} AND al.acknowledged = 0`
          )
          .get(req.user!.tenantId, ...commentScope.params) as { n: number }
      ).n;
      const openCases = (
        db
          .prepare(`SELECT COUNT(*) as n FROM service_recovery_cases src WHERE src.tenant_id = ? ${caseScope.clause} AND src.status = 'new'`)
          .get(req.user!.tenantId, ...caseScope.params) as { n: number }
      ).n;
      res.json({ unacknowledgedComments, openCases });
    }
  );

  router.patch(
    '/comments/:id/status',
    requireRole('QualityManager', 'DepartmentManager', 'SystemAdmin'),
    express.json({ limit: '8kb' }),
    async (req: Request, res: Response) => {
      const { status, resolutionNotes } = req.body as { status?: RecoveryStatus; resolutionNotes?: string };
      const validStatuses: RecoveryStatus[] = ['new', 'assigned', 'in_progress', 'closed'];
      if (!status || !validStatuses.includes(status)) {
        res.status(400).json({ error: 'invalid_status' });
        return;
      }

      const comment = db.prepare('SELECT id, tenant_id, department_id FROM comments WHERE id = ?').get(req.params.id) as
        | { id: string; tenant_id: string; department_id: string }
        | undefined;
      if (!comment || comment.tenant_id !== req.user!.tenantId) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (req.user!.role === 'DepartmentManager' && comment.department_id !== req.user!.departmentId) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      if (status === 'closed' && req.user!.role !== 'QualityManager' && req.user!.role !== 'SystemAdmin') {
        res.status(403).json({ error: 'closing_requires_quality_manager' });
        return;
      }

      const existingCase = db.prepare('SELECT id, patient_contact_opt_in, patient_contact_phone, patient_notified_at FROM service_recovery_cases WHERE comment_id = ?').get(
        comment.id
      ) as { id: string; patient_contact_opt_in: number; patient_contact_phone: string | null; patient_notified_at: string | null } | undefined;

      let caseId = existingCase?.id;
      if (existingCase) {
        db.prepare(
          `UPDATE service_recovery_cases
           SET status = ?, assigned_to = COALESCE(assigned_to, ?), resolution_notes = COALESCE(?, resolution_notes),
               closed_at = CASE WHEN ? = 'closed' THEN datetime('now') ELSE closed_at END,
               quality_approved_by = CASE WHEN ? = 'closed' THEN ? ELSE quality_approved_by END
           WHERE id = ?`
        ).run(status, req.user!.id, resolutionNotes ?? null, status, status, req.user!.id, existingCase.id);
      } else {
        caseId = uid();
        db.prepare(
          `INSERT INTO service_recovery_cases (id, comment_id, tenant_id, department_id, status, assigned_to, resolution_notes)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(caseId, comment.id, comment.tenant_id, comment.department_id, status, req.user!.id, resolutionNotes ?? null);
      }

      logAudit(db, req.user!.tenantId, req.user!.id, 'case_status_change', 'service_recovery_case', comment.id, { to: status });

      let patientNotified = false;
      if (status === 'closed' && existingCase?.patient_contact_opt_in && existingCase.patient_contact_phone && !existingCase.patient_notified_at) {
        const tenant = db.prepare('SELECT name_ar, name_en FROM tenants WHERE id = ?').get(req.user!.tenantId) as
          | { name_ar: string; name_en: string }
          | undefined;
        const smsConfig = getTenantSmsConfig(db, req.user!.tenantId);
        const provider = createSmsProvider(smsConfig);
        const message = composeResolutionMessage(tenant?.name_ar ?? 'تجربة', tenant?.name_en ?? 'Tajruba', smsConfig.defaultLanguage);
        const result = await provider.send(existingCase.patient_contact_phone, message);
        if (result.ok) {
          db.prepare("UPDATE service_recovery_cases SET patient_notified_at = datetime('now') WHERE id = ?").run(caseId!);
          patientNotified = true;
        }
        logAudit(db, req.user!.tenantId, req.user!.id, 'patient_closure_notification_sent', 'service_recovery_case', caseId ?? null, {
          ok: result.ok,
          provider: provider.name
        });
      }

      res.json({ ok: true, patientNotified });
    }
  );

  router.get('/service-recovery/cases', (req: Request, res: Response) => {
    const { clause, params } = departmentScopeFilter(req, 'src');
    const status = req.query.status as string | undefined;
    const rows = db
      .prepare(
        `SELECT src.id, src.comment_id, src.status, src.department_id, src.assigned_to, src.due_at, src.opened_at, src.closed_at, src.resolution_notes,
                src.patient_contact_opt_in, src.patient_notified_at,
                u.full_name as assigned_to_name,
                c.redacted_text, ca.severity, ca.category
         FROM service_recovery_cases src
         JOIN comments c ON c.id = src.comment_id
         JOIN comment_analyses ca ON ca.comment_id = c.id
         LEFT JOIN users u ON u.id = src.assigned_to
         WHERE src.tenant_id = ? ${clause} ${status ? 'AND src.status = ?' : ''}
         ORDER BY src.opened_at DESC`
      )
      .all(...[req.user!.tenantId, ...params, ...(status ? [status] : [])]);
    res.json({ cases: rows });
  });

  // Lightweight staff picker for assigning a recovery case — deliberately narrower than the
  // full /users admin endpoint (SystemAdmin-only) so a QualityManager/DepartmentManager can
  // see who to assign without full user-management access.
  router.get(
    '/service-recovery/assignable-users',
    requireRole('SystemAdmin', 'QualityManager', 'DepartmentManager'),
    (req: Request, res: Response) => {
      const departmentId = req.query.departmentId as string | undefined;
      if (req.user!.role === 'DepartmentManager' && departmentId !== req.user!.departmentId) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      const rows = db
        .prepare(
          `SELECT id, full_name, role FROM users
           WHERE tenant_id = ? AND active = 1 AND (department_id = ? OR role IN ('QualityManager', 'SystemAdmin'))
           ORDER BY full_name`
        )
        .all(req.user!.tenantId, departmentId ?? null);
      res.json({ users: rows });
    }
  );

  router.patch(
    '/service-recovery/cases/:id/assign',
    requireRole('SystemAdmin', 'QualityManager', 'DepartmentManager'),
    express.json({ limit: '8kb' }),
    (req: Request, res: Response) => {
      const existing = db.prepare('SELECT id, tenant_id, department_id FROM service_recovery_cases WHERE id = ?').get(req.params.id) as
        | { id: string; tenant_id: string; department_id: string }
        | undefined;
      if (!existing || existing.tenant_id !== req.user!.tenantId) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (req.user!.role === 'DepartmentManager' && existing.department_id !== req.user!.departmentId) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      const { assignedTo, dueAt } = req.body as { assignedTo?: string; dueAt?: string };
      if (assignedTo) {
        const assignee = db.prepare('SELECT id FROM users WHERE id = ? AND tenant_id = ? AND active = 1').get(assignedTo, req.user!.tenantId);
        if (!assignee) {
          res.status(400).json({ error: 'invalid_assignee' });
          return;
        }
      }
      db.prepare('UPDATE service_recovery_cases SET assigned_to = COALESCE(?, assigned_to), due_at = COALESCE(?, due_at) WHERE id = ?').run(
        assignedTo ?? null,
        dueAt ?? null,
        existing.id
      );
      logAudit(db, req.user!.tenantId, req.user!.id, 'case_assigned', 'service_recovery_case', existing.id, { assignedTo, dueAt });
      res.json({ ok: true });
    }
  );

  // -------------------------------------------------------------------------
  // Invitations
  // -------------------------------------------------------------------------
  router.post(
    '/invitations/bulk',
    requireRole('SystemAdmin', 'QualityManager', 'DepartmentManager'),
    express.json({ limit: '256kb' }),
    async (req: Request, res: Response) => {
      const { rows, templateId, departmentId, channel } = req.body as {
        rows?: { phone: string }[];
        templateId?: string;
        departmentId?: string;
        channel?: 'sms' | 'whatsapp' | 'phone';
      };
      if (!Array.isArray(rows) || rows.length === 0 || !templateId || !departmentId) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      if (req.user!.role === 'DepartmentManager' && departmentId !== req.user!.departmentId) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      const template = db
        .prepare('SELECT service_type, name_ar, name_en FROM survey_templates WHERE id = ? AND tenant_id = ?')
        .get(templateId, req.user!.tenantId) as { service_type: string; name_ar: string; name_en: string } | undefined;
      if (!template) {
        res.status(404).json({ error: 'template_not_found' });
        return;
      }

      const smsConfig = getTenantSmsConfig(db, req.user!.tenantId);
      const provider = createSmsProvider(smsConfig);
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const effectiveChannel = channel ?? 'sms';

      const insert = db.prepare(
        `INSERT INTO survey_invitations
         (id, tenant_id, template_id, department_id, service_type, token_hash, patient_phone_hash, channel, status, expires_at, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const now = new Date().toISOString();
      const expires = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
      let created = 0;
      let sent = 0;
      let skipped = 0;
      for (const row of rows) {
        if (!row.phone) continue;
        const phoneHash = sha256(row.phone);
        if (!isEligibleForInvitation(db, req.user!.tenantId, phoneHash).eligible) {
          skipped += 1;
          continue;
        }
        const rawToken = uid();
        let status = 'pending';
        if (effectiveChannel === 'sms' || effectiveChannel === 'whatsapp') {
          const surveyUrl = `${baseUrl}/s/${rawToken}`;
          const message = composeInvitationMessage(template.name_ar, template.name_en, surveyUrl, smsConfig.defaultLanguage);
          const result = await provider.send(row.phone, message);
          status = result.ok ? 'sent' : 'pending';
          if (result.ok) sent += 1;
        }
        insert.run(
          uid(),
          req.user!.tenantId,
          templateId,
          departmentId,
          template.service_type,
          sha256(rawToken),
          phoneHash,
          effectiveChannel,
          status,
          expires,
          now
        );
        created += 1;
      }
      logAudit(db, req.user!.tenantId, req.user!.id, 'invitations_bulk_created', 'survey_invitation', null, {
        count: created,
        sent,
        skipped,
        smsProvider: provider.name
      });
      res.status(201).json({ created, sent, skipped, smsProvider: provider.name });
    }
  );

  // -------------------------------------------------------------------------
  // QR / Kiosk links (admin management — the actual survey runs at /public/kiosk/:code)
  // -------------------------------------------------------------------------
  function generateKioskCode(): string {
    return randomUUID().replace(/-/g, '').slice(0, 10);
  }

  router.get('/kiosk-links', requireRole('SystemAdmin', 'QualityManager'), (req: Request, res: Response) => {
    const rows = db
      .prepare(
        `SELECT kl.id, kl.code, kl.label, kl.active, kl.response_count, kl.created_at,
                d.name_ar as department_name_ar, st.name_ar as template_name_ar, st.service_type
         FROM kiosk_links kl
         JOIN departments d ON d.id = kl.department_id
         JOIN survey_templates st ON st.id = kl.template_id
         WHERE kl.tenant_id = ? ORDER BY kl.created_at DESC`
      )
      .all(req.user!.tenantId);
    res.json({ kioskLinks: rows });
  });

  router.post('/kiosk-links', requireRole('SystemAdmin', 'QualityManager'), express.json({ limit: '8kb' }), (req: Request, res: Response) => {
    const { departmentId, templateId, label } = req.body as { departmentId?: string; templateId?: string; label?: string };
    if (!departmentId || !templateId) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const department = db.prepare('SELECT id FROM departments WHERE id = ? AND tenant_id = ?').get(departmentId, req.user!.tenantId);
    const template = db.prepare('SELECT id FROM survey_templates WHERE id = ? AND tenant_id = ?').get(templateId, req.user!.tenantId);
    if (!department || !template) {
      res.status(404).json({ error: 'department_or_template_not_found' });
      return;
    }
    const id = uid();
    const code = generateKioskCode();
    db.prepare('INSERT INTO kiosk_links (id, tenant_id, department_id, template_id, code, label, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id,
      req.user!.tenantId,
      departmentId,
      templateId,
      code,
      label ?? null,
      req.user!.id
    );
    logAudit(db, req.user!.tenantId, req.user!.id, 'kiosk_link_created', 'kiosk_link', id, { departmentId, templateId });
    res.status(201).json({ id, code });
  });

  router.patch('/kiosk-links/:id', requireRole('SystemAdmin', 'QualityManager'), express.json({ limit: '8kb' }), (req: Request, res: Response) => {
    const existing = db.prepare('SELECT id FROM kiosk_links WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user!.tenantId);
    if (!existing) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const { active, label } = req.body as { active?: boolean; label?: string };
    if (active !== undefined) db.prepare('UPDATE kiosk_links SET active = ? WHERE id = ?').run(active ? 1 : 0, req.params.id);
    if (label !== undefined) db.prepare('UPDATE kiosk_links SET label = ? WHERE id = ?').run(label, req.params.id);
    logAudit(db, req.user!.tenantId, req.user!.id, 'kiosk_link_updated', 'kiosk_link', req.params.id, req.body);
    res.json({ ok: true });
  });

  router.delete('/kiosk-links/:id', requireRole('SystemAdmin', 'QualityManager'), (req: Request, res: Response) => {
    const existing = db.prepare('SELECT id FROM kiosk_links WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user!.tenantId);
    if (!existing) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    db.prepare('UPDATE kiosk_links SET active = 0 WHERE id = ?').run(req.params.id);
    logAudit(db, req.user!.tenantId, req.user!.id, 'kiosk_link_deactivated', 'kiosk_link', req.params.id, null);
    res.json({ ok: true });
  });

  // Staff-assisted phone survey: an agent conducts the survey over a phone call and
  // enters the patient's answers on their behalf.
  router.post(
    '/phone-survey/submit',
    requireRole('SystemAdmin', 'QualityManager', 'DepartmentManager'),
    express.json({ limit: '64kb' }),
    (req: Request, res: Response) => {
      const body = req.body as {
        templateId?: string;
        departmentId?: string;
        patientPhone?: string;
        answers?: { questionId: string; value: number }[];
        comment?: string;
        contactOptIn?: boolean;
      };
      if (!body.templateId || !body.departmentId || !body.patientPhone || !Array.isArray(body.answers)) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      if (req.user!.role === 'DepartmentManager' && body.departmentId !== req.user!.departmentId) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      const template = db
        .prepare('SELECT id, service_type FROM survey_templates WHERE id = ? AND tenant_id = ?')
        .get(body.templateId, req.user!.tenantId) as { id: string; service_type: string } | undefined;
      if (!template) {
        res.status(404).json({ error: 'template_not_found' });
        return;
      }
      const department = db
        .prepare('SELECT id FROM departments WHERE id = ? AND tenant_id = ?')
        .get(body.departmentId, req.user!.tenantId);
      if (!department) {
        res.status(404).json({ error: 'department_not_found' });
        return;
      }

      const validQuestionIds = new Set(
        (
          db
            .prepare(
              `SELECT q.id FROM template_questions tq JOIN questions q ON q.id = tq.question_id WHERE tq.template_id = ?`
            )
            .all(template.id) as { id: string }[]
        ).map((r) => r.id)
      );

      const now = new Date().toISOString();
      const invitationId = uid();
      db.prepare(
        `INSERT INTO survey_invitations
         (id, tenant_id, template_id, department_id, service_type, token_hash, patient_phone_hash, channel, status, expires_at, sent_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'phone', 'completed', ?, ?, ?)`
      ).run(invitationId, req.user!.tenantId, template.id, body.departmentId, template.service_type, sha256(uid()), sha256(body.patientPhone), now, now, now);

      const responseId = uid();
      db.prepare(
        'INSERT INTO survey_responses (id, invitation_id, tenant_id, started_at, submitted_at, language, mode) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(responseId, invitationId, req.user!.tenantId, now, now, 'ar', 'phone');

      const insertAnswer = db.prepare('INSERT INTO answers (id, response_id, question_id, value_numeric) VALUES (?, ?, ?, ?)');
      for (const answer of body.answers) {
        if (!validQuestionIds.has(answer.questionId)) continue;
        if (typeof answer.value !== 'number' || !Number.isFinite(answer.value)) continue;
        insertAnswer.run(uid(), responseId, answer.questionId, answer.value);
      }

      if (body.comment && body.comment.trim().length > 0) {
        const rawText = body.comment.trim().slice(0, 2000);
        const redacted = redactPii(rawText);
        const analyzer = createDefaultAnalyzer();
        const analysis = analyzer.analyze(redacted);
        const commentId = uid();
        db.prepare(
          'INSERT INTO comments (id, response_id, tenant_id, department_id, raw_text, redacted_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(commentId, responseId, req.user!.tenantId, body.departmentId, rawText, redacted, now);
        db.prepare(
          'INSERT INTO comment_analyses (id, comment_id, sentiment, category, severity, analyzer) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(uid(), commentId, analysis.sentiment, analysis.category, analysis.severity, analysis.analyzer);
        if (shouldAlert(analysis.severity)) {
          db.prepare('INSERT INTO comment_alerts (id, comment_id, tenant_id, severity) VALUES (?, ?, ?, ?)').run(
            uid(),
            commentId,
            req.user!.tenantId,
            analysis.severity
          );
        }
        if (analysis.severity >= 3) {
          const optIn = body.contactOptIn === true;
          db.prepare(
            `INSERT INTO service_recovery_cases
             (id, comment_id, tenant_id, department_id, status, opened_at, patient_contact_opt_in, patient_contact_phone)
             VALUES (?, ?, ?, ?, 'new', ?, ?, ?)`
          ).run(uid(), commentId, req.user!.tenantId, body.departmentId, now, optIn ? 1 : 0, optIn ? body.patientPhone! : null);
        }
      }

      logAudit(db, req.user!.tenantId, req.user!.id, 'phone_survey_submitted', 'survey_response', responseId, null);
      res.status(201).json({ ok: true });
    }
  );

  // -------------------------------------------------------------------------
  // PROMs
  // -------------------------------------------------------------------------
  router.get('/proms/instruments', (req: Request, res: Response) => {
    const includeInactive = req.query.includeInactive === '1' && req.user!.role === 'SystemAdmin';
    const instruments = db
      .prepare(
        `SELECT id, code, name_ar, name_en, license_status, description_ar, higher_is_better, mcid_threshold, active
         FROM proms_instruments WHERE tenant_id = ? ${includeInactive ? '' : 'AND active = 1'}`
      )
      .all(req.user!.tenantId) as { id: string }[];
    const withItems = instruments.map((i) => ({
      ...i,
      items: db
        .prepare('SELECT id, code, text_ar, text_en, reverse_scored, scale_max, sort_order FROM proms_instrument_items WHERE instrument_id = ? ORDER BY sort_order')
        .all(i.id)
    }));
    res.json({ instruments: withItems });
  });

  router.post(
    '/proms/instruments',
    requireRole('SystemAdmin'),
    express.json({ limit: '8kb' }),
    (req: Request, res: Response) => {
      const { code, nameAr, nameEn, licenseStatus, descriptionAr, higherIsBetter, mcidThreshold } = req.body as {
        code?: string;
        nameAr?: string;
        nameEn?: string;
        licenseStatus?: string;
        descriptionAr?: string;
        higherIsBetter?: boolean;
        mcidThreshold?: number;
      };
      if (!code || !nameAr || !nameEn || !licenseStatus || !descriptionAr) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      if (licenseStatus !== 'free' && licenseStatus !== 'licensed_required') {
        res.status(400).json({ error: 'invalid_license_status' });
        return;
      }
      const id = uid();
      try {
        db.prepare(
          `INSERT INTO proms_instruments (id, tenant_id, code, name_ar, name_en, license_status, description_ar, higher_is_better, mcid_threshold)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, req.user!.tenantId, code, nameAr, nameEn, licenseStatus, descriptionAr, higherIsBetter ? 1 : 0, mcidThreshold ?? 1);
      } catch {
        res.status(409).json({ error: 'code_already_exists' });
        return;
      }
      logAudit(db, req.user!.tenantId, req.user!.id, 'instrument_created', 'proms_instrument', id, { code });
      res.status(201).json({ id });
    }
  );

  router.patch(
    '/proms/instruments/:id',
    requireRole('SystemAdmin'),
    express.json({ limit: '8kb' }),
    (req: Request, res: Response) => {
      const existing = db.prepare('SELECT id FROM proms_instruments WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user!.tenantId);
      if (!existing) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const { nameAr, nameEn, licenseStatus, descriptionAr, higherIsBetter, mcidThreshold, active } = req.body as {
        nameAr?: string;
        nameEn?: string;
        licenseStatus?: string;
        descriptionAr?: string;
        higherIsBetter?: boolean;
        mcidThreshold?: number;
        active?: boolean;
      };
      if (nameAr !== undefined) db.prepare('UPDATE proms_instruments SET name_ar = ? WHERE id = ?').run(nameAr, req.params.id);
      if (nameEn !== undefined) db.prepare('UPDATE proms_instruments SET name_en = ? WHERE id = ?').run(nameEn, req.params.id);
      if (descriptionAr !== undefined) db.prepare('UPDATE proms_instruments SET description_ar = ? WHERE id = ?').run(descriptionAr, req.params.id);
      if (licenseStatus === 'free' || licenseStatus === 'licensed_required')
        db.prepare('UPDATE proms_instruments SET license_status = ? WHERE id = ?').run(licenseStatus, req.params.id);
      if (higherIsBetter !== undefined)
        db.prepare('UPDATE proms_instruments SET higher_is_better = ? WHERE id = ?').run(higherIsBetter ? 1 : 0, req.params.id);
      if (mcidThreshold !== undefined) db.prepare('UPDATE proms_instruments SET mcid_threshold = ? WHERE id = ?').run(mcidThreshold, req.params.id);
      if (active !== undefined) db.prepare('UPDATE proms_instruments SET active = ? WHERE id = ?').run(active ? 1 : 0, req.params.id);
      logAudit(db, req.user!.tenantId, req.user!.id, 'instrument_updated', 'proms_instrument', req.params.id, req.body);
      res.json({ ok: true });
    }
  );

  router.post(
    '/proms/instruments/:id/items',
    requireRole('SystemAdmin'),
    express.json({ limit: '8kb' }),
    (req: Request, res: Response) => {
      const instrument = db.prepare('SELECT id FROM proms_instruments WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user!.tenantId);
      if (!instrument) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const { code, textAr, textEn, reverseScored, scaleMax } = req.body as {
        code?: string;
        textAr?: string;
        textEn?: string;
        reverseScored?: boolean;
        scaleMax?: number;
      };
      if (!code || !textAr || !textEn || !scaleMax || scaleMax < 1) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const nextSortOrder = (
        db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 as n FROM proms_instrument_items WHERE instrument_id = ?').get(req.params.id) as {
          n: number;
        }
      ).n;
      const id = uid();
      db.prepare(
        `INSERT INTO proms_instrument_items (id, instrument_id, code, text_ar, text_en, reverse_scored, scale_max, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, req.params.id, code, textAr, textEn, reverseScored ? 1 : 0, scaleMax, nextSortOrder);
      logAudit(db, req.user!.tenantId, req.user!.id, 'instrument_item_created', 'proms_instrument_item', id, { code });
      res.status(201).json({ id });
    }
  );

  router.patch(
    '/proms/instrument-items/:id',
    requireRole('SystemAdmin'),
    express.json({ limit: '8kb' }),
    (req: Request, res: Response) => {
      const existing = db
        .prepare(
          `SELECT pii.id FROM proms_instrument_items pii
           JOIN proms_instruments pi ON pi.id = pii.instrument_id
           WHERE pii.id = ? AND pi.tenant_id = ?`
        )
        .get(req.params.id, req.user!.tenantId);
      if (!existing) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const { textAr, textEn, reverseScored, scaleMax } = req.body as {
        textAr?: string;
        textEn?: string;
        reverseScored?: boolean;
        scaleMax?: number;
      };
      if (textAr !== undefined) db.prepare('UPDATE proms_instrument_items SET text_ar = ? WHERE id = ?').run(textAr, req.params.id);
      if (textEn !== undefined) db.prepare('UPDATE proms_instrument_items SET text_en = ? WHERE id = ?').run(textEn, req.params.id);
      if (reverseScored !== undefined)
        db.prepare('UPDATE proms_instrument_items SET reverse_scored = ? WHERE id = ?').run(reverseScored ? 1 : 0, req.params.id);
      if (scaleMax !== undefined && scaleMax >= 1) db.prepare('UPDATE proms_instrument_items SET scale_max = ? WHERE id = ?').run(scaleMax, req.params.id);
      logAudit(db, req.user!.tenantId, req.user!.id, 'instrument_item_updated', 'proms_instrument_item', req.params.id, req.body);
      res.json({ ok: true });
    }
  );

  router.get('/proms/pathways', (req: Request, res: Response) => {
    const includeInactive = req.query.includeInactive === '1' && req.user!.role === 'SystemAdmin';
    const pathways = db
      .prepare(`SELECT id, code, name_ar, name_en, active FROM care_pathways WHERE tenant_id = ? ${includeInactive ? '' : 'AND active = 1'}`)
      .all(req.user!.tenantId) as { id: string; code: string; name_ar: string; name_en: string }[];
    const withTimepoints = pathways.map((p) => ({
      ...p,
      timepoints: db
        .prepare('SELECT id, code, name_ar, offset_days, window_days, instrument_ids_json FROM pathway_timepoints WHERE pathway_id = ? ORDER BY sort_order')
        .all(p.id)
    }));
    res.json({ pathways: withTimepoints });
  });

  router.post(
    '/proms/pathways',
    requireRole('SystemAdmin'),
    express.json({ limit: '8kb' }),
    (req: Request, res: Response) => {
      const { code, nameAr, nameEn } = req.body as { code?: string; nameAr?: string; nameEn?: string };
      if (!code || !nameAr || !nameEn) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const id = uid();
      try {
        db.prepare('INSERT INTO care_pathways (id, tenant_id, code, name_ar, name_en) VALUES (?, ?, ?, ?, ?)').run(
          id,
          req.user!.tenantId,
          code,
          nameAr,
          nameEn
        );
      } catch {
        res.status(409).json({ error: 'code_already_exists' });
        return;
      }
      logAudit(db, req.user!.tenantId, req.user!.id, 'pathway_created', 'care_pathway', id, { code });
      res.status(201).json({ id });
    }
  );

  router.patch(
    '/proms/pathways/:id',
    requireRole('SystemAdmin'),
    express.json({ limit: '8kb' }),
    (req: Request, res: Response) => {
      const existing = db.prepare('SELECT id FROM care_pathways WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user!.tenantId);
      if (!existing) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const { nameAr, nameEn, active } = req.body as { nameAr?: string; nameEn?: string; active?: boolean };
      if (nameAr !== undefined) db.prepare('UPDATE care_pathways SET name_ar = ? WHERE id = ?').run(nameAr, req.params.id);
      if (nameEn !== undefined) db.prepare('UPDATE care_pathways SET name_en = ? WHERE id = ?').run(nameEn, req.params.id);
      if (active !== undefined) db.prepare('UPDATE care_pathways SET active = ? WHERE id = ?').run(active ? 1 : 0, req.params.id);
      logAudit(db, req.user!.tenantId, req.user!.id, 'pathway_updated', 'care_pathway', req.params.id, req.body);
      res.json({ ok: true });
    }
  );

  router.post(
    '/proms/pathways/:id/timepoints',
    requireRole('SystemAdmin'),
    express.json({ limit: '8kb' }),
    (req: Request, res: Response) => {
      const pathway = db.prepare('SELECT id FROM care_pathways WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user!.tenantId);
      if (!pathway) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const { code, nameAr, offsetDays, windowDays, instrumentIds } = req.body as {
        code?: string;
        nameAr?: string;
        offsetDays?: number;
        windowDays?: number;
        instrumentIds?: string[];
      };
      if (!code || !nameAr || offsetDays === undefined || !Array.isArray(instrumentIds) || instrumentIds.length === 0) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const validInstrumentIds = new Set(
        (
          db.prepare('SELECT id FROM proms_instruments WHERE tenant_id = ?').all(req.user!.tenantId) as { id: string }[]
        ).map((i) => i.id)
      );
      if (!instrumentIds.every((id) => validInstrumentIds.has(id))) {
        res.status(400).json({ error: 'invalid_instrument_id' });
        return;
      }
      const nextSortOrder = (
        db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 as n FROM pathway_timepoints WHERE pathway_id = ?').get(req.params.id) as {
          n: number;
        }
      ).n;
      const id = uid();
      db.prepare(
        `INSERT INTO pathway_timepoints (id, pathway_id, code, name_ar, offset_days, window_days, instrument_ids_json, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, req.params.id, code, nameAr, offsetDays, windowDays ?? 14, JSON.stringify(instrumentIds), nextSortOrder);
      logAudit(db, req.user!.tenantId, req.user!.id, 'timepoint_created', 'pathway_timepoint', id, { code });
      res.status(201).json({ id });
    }
  );

  router.patch(
    '/proms/timepoints/:id',
    requireRole('SystemAdmin'),
    express.json({ limit: '8kb' }),
    (req: Request, res: Response) => {
      const existing = db
        .prepare(
          `SELECT pt.id FROM pathway_timepoints pt JOIN care_pathways cp ON cp.id = pt.pathway_id WHERE pt.id = ? AND cp.tenant_id = ?`
        )
        .get(req.params.id, req.user!.tenantId);
      if (!existing) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const { nameAr, offsetDays, windowDays, instrumentIds } = req.body as {
        nameAr?: string;
        offsetDays?: number;
        windowDays?: number;
        instrumentIds?: string[];
      };
      if (nameAr !== undefined) db.prepare('UPDATE pathway_timepoints SET name_ar = ? WHERE id = ?').run(nameAr, req.params.id);
      if (offsetDays !== undefined) db.prepare('UPDATE pathway_timepoints SET offset_days = ? WHERE id = ?').run(offsetDays, req.params.id);
      if (windowDays !== undefined) db.prepare('UPDATE pathway_timepoints SET window_days = ? WHERE id = ?').run(windowDays, req.params.id);
      if (instrumentIds !== undefined) {
        const validInstrumentIds = new Set(
          (
            db.prepare('SELECT id FROM proms_instruments WHERE tenant_id = ?').all(req.user!.tenantId) as { id: string }[]
          ).map((i) => i.id)
        );
        if (!Array.isArray(instrumentIds) || instrumentIds.length === 0 || !instrumentIds.every((id) => validInstrumentIds.has(id))) {
          res.status(400).json({ error: 'invalid_instrument_id' });
          return;
        }
        db.prepare('UPDATE pathway_timepoints SET instrument_ids_json = ? WHERE id = ?').run(JSON.stringify(instrumentIds), req.params.id);
      }
      logAudit(db, req.user!.tenantId, req.user!.id, 'timepoint_updated', 'pathway_timepoint', req.params.id, req.body);
      res.json({ ok: true });
    }
  );

  router.get('/proms/outcomes', (req: Request, res: Response) => {
    const pathwayId = req.query.pathwayId as string | undefined;
    if (!pathwayId) {
      res.status(400).json({ error: 'pathway_id_required' });
      return;
    }
    const pathway = db.prepare('SELECT id FROM care_pathways WHERE id = ? AND tenant_id = ?').get(pathwayId, req.user!.tenantId);
    if (!pathway) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const { clause, params } = departmentScopeFilter(req, 'patient_episodes');
    const episodes = db
      .prepare(`SELECT id, patient_ref_hash, surgeon_ref, start_date, status FROM patient_episodes WHERE pathway_id = ? ${clause}`)
      .all(pathwayId, ...params) as { id: string; patient_ref_hash: string; surgeon_ref: string; start_date: string; status: string }[];

    const episodeResults = episodes.map((episode) => {
      const scores = db
        .prepare(
          `SELECT pt.code as timepoint_code, pt.name_ar as timepoint_name, ps.raw_score, ps.band, ps.baseline_score, ps.delta, ps.mcid_met
           FROM prom_assignments pa
           JOIN pathway_timepoints pt ON pt.id = pa.timepoint_id
           JOIN prom_scores ps ON ps.assignment_id = pa.id
           WHERE pa.episode_id = ?
           ORDER BY pt.sort_order`
        )
        .all(episode.id);
      return { ...episode, scores };
    });

    const byTimepoint = new Map<string, { total: number; mcidMet: number }>();
    for (const ep of episodeResults) {
      for (const score of ep.scores as { timepoint_code: string; mcid_met: number | null }[]) {
        if (score.mcid_met === null) continue;
        const entry = byTimepoint.get(score.timepoint_code) ?? { total: 0, mcidMet: 0 };
        entry.total += 1;
        if (score.mcid_met) entry.mcidMet += 1;
        byTimepoint.set(score.timepoint_code, entry);
      }
    }
    const mcidSummary = Array.from(byTimepoint.entries()).map(([timepoint, v]) => ({
      timepoint,
      total: v.total,
      mcidMetPercent: v.total > 0 ? Math.round((v.mcidMet / v.total) * 1000) / 10 : null
    }));

    res.json({ episodes: episodeResults, mcidSummary });
  });

  function createEpisode(
    db: Db,
    tenantId: string,
    body: {
      pathwayId?: string;
      departmentId?: string;
      patientRef?: string;
      contactPhone?: string;
      surgeonRef?: string;
      startDate?: string;
      consent?: boolean;
    }
  ): { ok: true; id: string } | { ok: false; error: string } {
    const { pathwayId, departmentId, patientRef, contactPhone, surgeonRef, startDate, consent } = body;
    if (!pathwayId || !departmentId || !patientRef || !startDate) {
      return { ok: false, error: 'invalid_payload' };
    }
    // A phone number means the patient will be contacted repeatedly over the life of the
    // pathway (up to 12 months) using their raw, unhashed number — that requires their
    // explicit consent to be captured up front, not assumed.
    if (contactPhone && consent !== true) {
      return { ok: false, error: 'consent_required' };
    }
    const pathway = db.prepare('SELECT id FROM care_pathways WHERE id = ? AND tenant_id = ? AND active = 1').get(pathwayId, tenantId);
    const department = db.prepare('SELECT id FROM departments WHERE id = ? AND tenant_id = ? AND active = 1').get(departmentId, tenantId);
    if (!pathway || !department) {
      return { ok: false, error: 'pathway_or_department_not_found' };
    }
    const episodeId = uid();
    db.prepare(
      `INSERT INTO patient_episodes (id, tenant_id, pathway_id, department_id, patient_ref_hash, contact_phone, surgeon_ref, start_date, status, consent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`
    ).run(
      episodeId,
      tenantId,
      pathwayId,
      departmentId,
      sha256(patientRef),
      contactPhone ?? null,
      surgeonRef ?? null,
      startDate,
      contactPhone ? new Date().toISOString() : null
    );

    const timepoints = db
      .prepare('SELECT id, offset_days, instrument_ids_json FROM pathway_timepoints WHERE pathway_id = ?')
      .all(pathwayId) as { id: string; offset_days: number; instrument_ids_json: string }[];
    const insertAssignment = db.prepare(
      'INSERT INTO prom_assignments (id, episode_id, timepoint_id, instrument_id, due_date, status) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const start = new Date(startDate);
    for (const tp of timepoints) {
      const due = new Date(start);
      due.setDate(due.getDate() + tp.offset_days);
      const instrumentIds = JSON.parse(tp.instrument_ids_json) as string[];
      for (const instrumentId of instrumentIds) {
        insertAssignment.run(uid(), episodeId, tp.id, instrumentId, due.toISOString(), 'scheduled');
      }
    }
    return { ok: true, id: episodeId };
  }

  router.post(
    '/episodes',
    requireRole('SystemAdmin', 'QualityManager', 'DepartmentManager'),
    express.json({ limit: '8kb' }),
    (req: Request, res: Response) => {
      if (req.user!.role === 'DepartmentManager' && req.body?.departmentId !== req.user!.departmentId) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      const result = createEpisode(db, req.user!.tenantId, req.body);
      if (!result.ok) {
        const status = result.error === 'consent_required' ? 400 : result.error.endsWith('not_found') ? 404 : 400;
        res.status(status).json({ error: result.error });
        return;
      }
      logAudit(db, req.user!.tenantId, req.user!.id, 'episode_created', 'patient_episode', result.id, null);
      res.status(201).json({ id: result.id });
    }
  );

  router.get(
    '/proms/due-assignments',
    requireRole('SystemAdmin', 'QualityManager', 'DepartmentManager'),
    (req: Request, res: Response) => {
      const { clause, params } = departmentScopeFilter(req, 'pe');
      const rows = db
        .prepare(
          `SELECT pa.id, pa.due_date, pa.status, pe.id as episode_id, pe.contact_phone, pe.surgeon_ref,
                  pt.name_ar as timepoint_name_ar, pi.name_ar as instrument_name_ar, pi.license_status,
                  cp.name_ar as pathway_name_ar
           FROM prom_assignments pa
           JOIN patient_episodes pe ON pe.id = pa.episode_id
           JOIN pathway_timepoints pt ON pt.id = pa.timepoint_id
           JOIN proms_instruments pi ON pi.id = pa.instrument_id
           JOIN care_pathways cp ON cp.id = pe.pathway_id
           WHERE pe.tenant_id = ? ${clause} AND pa.status = 'scheduled' AND datetime(pa.due_date) <= datetime('now')
           ORDER BY pa.due_date ASC`
        )
        .all(req.user!.tenantId, ...params);
      res.json({ assignments: rows });
    }
  );

  router.post(
    '/assignments/:id/send',
    requireRole('SystemAdmin', 'QualityManager', 'DepartmentManager'),
    async (req: Request, res: Response) => {
      const assignment = db
        .prepare(
          `SELECT pa.id, pa.status, pe.tenant_id, pe.department_id, pe.contact_phone, pe.opted_out_at,
                  pi.name_ar as instrument_name_ar, pi.name_en as instrument_name_en,
                  pi.license_status, pt.name_ar as timepoint_name_ar
           FROM prom_assignments pa
           JOIN patient_episodes pe ON pe.id = pa.episode_id
           JOIN proms_instruments pi ON pi.id = pa.instrument_id
           JOIN pathway_timepoints pt ON pt.id = pa.timepoint_id
           WHERE pa.id = ?`
        )
        .get(req.params.id) as
        | {
            id: string;
            status: string;
            tenant_id: string;
            department_id: string;
            contact_phone: string | null;
            opted_out_at: string | null;
            instrument_name_ar: string;
            instrument_name_en: string;
            license_status: string;
            timepoint_name_ar: string;
          }
        | undefined;
      if (!assignment || assignment.tenant_id !== req.user!.tenantId) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (req.user!.role === 'DepartmentManager' && assignment.department_id !== req.user!.departmentId) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      if (assignment.license_status !== 'free') {
        res.status(409).json({ error: 'instrument_requires_manual_administration' });
        return;
      }
      if (assignment.opted_out_at) {
        res.status(409).json({ error: 'patient_opted_out' });
        return;
      }
      if (!assignment.contact_phone) {
        res.status(409).json({ error: 'no_contact_phone_on_episode' });
        return;
      }
      if (assignment.status !== 'scheduled') {
        res.status(409).json({ error: 'assignment_not_scheduled' });
        return;
      }

      const rawToken = uid();
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const formUrl = `${baseUrl}/p/${rawToken}`;
      const optOutUrl = `${formUrl}/opt-out`;
      const smsConfig = getTenantSmsConfig(db, req.user!.tenantId);
      const provider = createSmsProvider(smsConfig);
      const message = composePromsMessage(
        assignment.instrument_name_ar,
        assignment.instrument_name_en,
        assignment.timepoint_name_ar,
        formUrl,
        optOutUrl,
        smsConfig.defaultLanguage
      );
      const result = await provider.send(assignment.contact_phone, message);

      db.prepare("UPDATE prom_assignments SET token_hash = ?, status = 'sent', sent_at = datetime('now') WHERE id = ?").run(
        sha256(rawToken),
        assignment.id
      );
      logAudit(db, req.user!.tenantId, req.user!.id, 'proms_assignment_sent', 'prom_assignment', assignment.id, { ok: result.ok });
      res.json({ ok: true, sent: result.ok });
    }
  );

  // -------------------------------------------------------------------------
  // Settings: integrations (SMS/WhatsApp provider + HIS webhook)
  // -------------------------------------------------------------------------
  router.get('/settings/integrations', requireRole('SystemAdmin'), (req: Request, res: Response) => {
    const row = getOrCreateIntegrationsRow(db, req.user!.tenantId);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({
      smsProvider: row.sms_provider,
      smsSenderName: row.sms_sender_name,
      smsApiKeyMasked: maskSecret(row.sms_api_key),
      defaultLanguage: row.default_language,
      hisWebhookEnabled: !!row.his_webhook_enabled,
      hisWebhookConfigured: !!row.his_webhook_key_hash,
      hisWebhookUrl: `${baseUrl}/api/webhooks/invitations`,
      hisEpisodesWebhookUrl: `${baseUrl}/api/webhooks/episodes`
    });
  });

  router.patch(
    '/settings/integrations',
    requireRole('SystemAdmin'),
    express.json({ limit: '8kb' }),
    (req: Request, res: Response) => {
      const body = req.body as {
        smsProvider?: string;
        smsApiKey?: string;
        smsSenderName?: string;
        defaultLanguage?: string;
        hisWebhookEnabled?: boolean;
      };
      getOrCreateIntegrationsRow(db, req.user!.tenantId);

      const updates: string[] = [];
      const params: (string | number)[] = [];
      if (body.smsProvider !== undefined) {
        updates.push('sms_provider = ?');
        params.push(body.smsProvider);
      }
      if (body.smsApiKey !== undefined && body.smsApiKey.trim().length > 0) {
        updates.push('sms_api_key = ?');
        params.push(body.smsApiKey.trim());
      }
      if (body.smsSenderName !== undefined) {
        updates.push('sms_sender_name = ?');
        params.push(body.smsSenderName.trim());
      }
      if (body.defaultLanguage !== undefined && (body.defaultLanguage === 'ar' || body.defaultLanguage === 'en')) {
        updates.push('default_language = ?');
        params.push(body.defaultLanguage);
      }
      if (body.hisWebhookEnabled !== undefined) {
        updates.push('his_webhook_enabled = ?');
        params.push(body.hisWebhookEnabled ? 1 : 0);
      }
      if (updates.length > 0) {
        updates.push("updated_at = datetime('now')");
        db.prepare(`UPDATE tenant_integrations SET ${updates.join(', ')} WHERE tenant_id = ?`).run(...params, req.user!.tenantId);
      }
      logAudit(db, req.user!.tenantId, req.user!.id, 'integrations_updated', 'tenant_integrations', null, {
        fields: Object.keys(body)
      });
      res.json({ ok: true });
    }
  );

  router.post(
    '/settings/integrations/test-sms',
    requireRole('SystemAdmin'),
    express.json({ limit: '8kb' }),
    async (req: Request, res: Response) => {
      const { phone } = req.body as { phone?: string };
      if (!phone) {
        res.status(400).json({ error: 'phone_required' });
        return;
      }
      const smsConfig = getTenantSmsConfig(db, req.user!.tenantId);
      const provider = createSmsProvider(smsConfig);
      const message =
        smsConfig.defaultLanguage === 'en'
          ? 'This is a test message from Tajruba.'
          : 'هذه رسالة تجريبية من منصة تجربة.';
      const result = await provider.send(phone, message);
      res.json({ ok: result.ok, provider: provider.name, error: result.error });
    }
  );

  router.post('/settings/integrations/webhook-key/regenerate', requireRole('SystemAdmin'), (req: Request, res: Response) => {
    getOrCreateIntegrationsRow(db, req.user!.tenantId);
    const rawKey = `tjb_${uid().replace(/-/g, '')}`;
    db.prepare("UPDATE tenant_integrations SET his_webhook_key_hash = ?, his_webhook_enabled = 1, updated_at = datetime('now') WHERE tenant_id = ?").run(
      sha256(rawKey),
      req.user!.tenantId
    );
    logAudit(db, req.user!.tenantId, req.user!.id, 'webhook_key_regenerated', 'tenant_integrations', null, null);
    res.json({ key: rawKey });
  });

  // -------------------------------------------------------------------------
  // Do-Not-Contact list (sampling frame)
  // -------------------------------------------------------------------------
  router.get('/settings/do-not-contact', requireRole('SystemAdmin', 'QualityManager'), (req: Request, res: Response) => {
    const rows = db
      .prepare('SELECT id, reason, created_at FROM do_not_contact_list WHERE tenant_id = ? ORDER BY created_at DESC')
      .all(req.user!.tenantId);
    res.json({ entries: rows, cooldownDays: INVITATION_COOLDOWN_DAYS });
  });

  router.post(
    '/settings/do-not-contact',
    requireRole('SystemAdmin', 'QualityManager'),
    express.json({ limit: '16kb' }),
    (req: Request, res: Response) => {
      const { phone, reason } = req.body as { phone?: string; reason?: string };
      if (!phone) {
        res.status(400).json({ error: 'phone_required' });
        return;
      }
      const phoneHash = sha256(phone);
      db.prepare(
        'INSERT OR IGNORE INTO do_not_contact_list (id, tenant_id, phone_hash, reason, created_by) VALUES (?, ?, ?, ?, ?)'
      ).run(uid(), req.user!.tenantId, phoneHash, reason ?? null, req.user!.id);
      logAudit(db, req.user!.tenantId, req.user!.id, 'dnc_entry_added', 'do_not_contact_list', null, { reason });
      res.status(201).json({ ok: true });
    }
  );

  router.delete('/settings/do-not-contact/:id', requireRole('SystemAdmin', 'QualityManager'), (req: Request, res: Response) => {
    db.prepare('DELETE FROM do_not_contact_list WHERE id = ? AND tenant_id = ?').run(req.params.id, req.user!.tenantId);
    logAudit(db, req.user!.tenantId, req.user!.id, 'dnc_entry_removed', 'do_not_contact_list', req.params.id, null);
    res.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Audit log
  // -------------------------------------------------------------------------
  router.get('/audit-logs', requireRole('SystemAdmin', 'QualityManager'), (req: Request, res: Response) => {
    const rows = db
      .prepare('SELECT id, user_id, action, entity, entity_id, metadata_json, created_at FROM audit_logs WHERE tenant_id IS NULL OR tenant_id = ? ORDER BY created_at DESC LIMIT 200')
      .all(req.user!.tenantId);
    res.json({ logs: rows });
  });

  return router;
}

// Re-exported for the demo PROMs scoring reference used by the outcomes UI.
export { INSTRUMENTS };
