import { randomUUID, createHash } from 'node:crypto';
import express, { Router, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
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
  pearsonCorrelation,
  scoreAgreePercent,
  scoreDistribution,
  scoreDomain,
  scorePromoterPercent,
  scoreInstrument,
  scoreNps,
  scoreQuestion,
  scoreYesNo,
  type InstrumentDefinition,
  type InstrumentItemValue
} from './scoring.ts';
import { DEFAULT_DEPARTMENTS, provisionTenantDefaults } from './provisioning.ts';
import {
  composeEmployeeSurveyMessage,
  composeInvitationMessage,
  composePromsMessage,
  composePromsReminderMessage,
  composeResolutionMessage,
  createSmsProvider,
  type TenantSmsConfig
} from './sms.ts';
import { composeEmployeeSurveyEmail, composeInvitationEmail, composePasswordResetEmail, createEmailProvider } from './email.ts';
import { decryptPii, encryptPii } from './crypto.ts';
import { sendCsv, sendXlsx, type ExportCell } from './export.ts';
import { defaultBackupDir, listBackups, runBackup } from './backup.ts';
import { buildEnrollmentQrCode, consumeRecoveryCode, createMfaSecret, generateRecoveryCodes, verifyMfaToken } from './mfa.ts';
import { AGE_BANDS, type AgeBand, type AnswerType, type RecoveryStatus, type Role, type ServiceType } from './types.ts';

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

interface TenantBranding {
  logoDataUri: string | null;
  primaryColor: string;
}

function getTenantBranding(db: Db, tenantId: string): TenantBranding {
  const row = db.prepare('SELECT logo_data_uri, brand_primary_color FROM tenants WHERE id = ?').get(tenantId) as
    | { logo_data_uri: string | null; brand_primary_color: string }
    | undefined;
  return { logoDataUri: row?.logo_data_uri ?? null, primaryColor: row?.brand_primary_color ?? '#059669' };
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

// Employee experience/engagement confidentiality floor (RFP OPT-03E): a department/job-category
// breakdown with fewer respondents than this is suppressed rather than shown, since a small
// enough group can make individual answers identifiable even without a stored employee link.
const MIN_GROUP_SIZE_FOR_REPORTING = 5;
const EMPLOYEE_SURVEY_LINK_VALID_DAYS = 21;

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
    assignment.contact_phone = decryptPii(assignment.contact_phone);
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
    assignment.contact_phone = decryptPii(assignment.contact_phone);
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

// Multi-level SLA escalation for service recovery cases (RFP SRC-03): level 1 fires the moment a
// case's due_at passes with no closure, level 2 (executive management) fires after another 24
// overdue hours. Reuses the existing comment_alerts notification mechanism (rather than a new
// notification channel) so an escalation surfaces through the same badge/list UI a fresh negative
// comment does, with severity bumped so it stands out. Intended to be called on an interval from
// server.ts, same pattern as autoSendDuePromsAssignments above.
const ESCALATION_LEVELS: { afterHoursOverdue: number; toRole: string }[] = [
  { afterHoursOverdue: 0, toRole: 'QualityManager' },
  { afterHoursOverdue: 24, toRole: 'SystemAdmin' }
];

export function escalateOverdueCases(db: Db): { escalated: number } {
  const now = Date.now();
  const openCases = db
    .prepare(
      `SELECT id, tenant_id, comment_id, due_at, escalation_level FROM service_recovery_cases
       WHERE status != 'closed' AND due_at IS NOT NULL AND escalation_level < ?`
    )
    .all(ESCALATION_LEVELS.length) as { id: string; tenant_id: string; comment_id: string; due_at: string; escalation_level: number }[];

  let escalated = 0;
  const updateLevel = db.prepare('UPDATE service_recovery_cases SET escalation_level = ? WHERE id = ?');
  const insertEscalation = db.prepare(
    'INSERT INTO case_escalations (id, case_id, tenant_id, level, escalated_to_role) VALUES (?, ?, ?, ?, ?)'
  );
  const insertAlert = db.prepare('INSERT INTO comment_alerts (id, comment_id, tenant_id, severity) VALUES (?, ?, ?, ?)');

  for (const c of openCases) {
    const overdueHours = (now - new Date(c.due_at).getTime()) / (60 * 60 * 1000);
    if (overdueHours < 0) continue;
    const levelDef = ESCALATION_LEVELS[c.escalation_level];
    if (overdueHours < levelDef.afterHoursOverdue) continue;
    const nextLevel = c.escalation_level + 1;
    updateLevel.run(nextLevel, c.id);
    insertEscalation.run(randomUUID(), c.id, c.tenant_id, nextLevel, levelDef.toRole);
    insertAlert.run(randomUUID(), c.comment_id, c.tenant_id, Math.min(5, 3 + nextLevel));
    escalated += 1;
  }
  return { escalated };
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

  // Rate limiters for the endpoints most exposed to abuse: unauthenticated login/password-reset
  // attempts (brute force) and public, token-less submission endpoints (spam/flooding). These
  // are IP-scoped defense-in-depth on top of the app's own logic (token hashing, API-key
  // checks). Created per createApi() call (one per running app, or one per test) so their
  // in-memory counters never leak between independent app instances. If this app sits behind a
  // reverse proxy/load balancer in production, `app.set('trust proxy', ...)` must be configured
  // to match that topology so req.ip reflects the real client, not the proxy.
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'too_many_attempts' }
  });

  const passwordResetLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'too_many_attempts' }
  });

  const publicSubmitLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'too_many_requests' }
  });

  const webhookLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'too_many_requests' }
  });

  // Liveness/readiness probe for external uptime monitoring (UptimeRobot, a load balancer
  // health check, etc.) — public, unauthenticated, deliberately not rate-limited since
  // monitoring tools poll frequently by design. Confirms the process is up AND the database is
  // actually reachable, not just that the HTTP server is listening.
  router.get('/health', (_req: Request, res: Response) => {
    try {
      db.prepare('SELECT 1').get();
      res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()), timestamp: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: 'error', uptimeSeconds: Math.round(process.uptime()), timestamp: new Date().toISOString() });
    }
  });

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
      branding: getTenantBranding(db, invitation.tenant_id),
      questions
    });
  });

  router.post('/public/surveys/:token/submit', publicSubmitLimiter, express.json({ limit: '64kb' }), (req: Request, res: Response) => {
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
        ).run(uid(), commentId, invitation.tenant_id, invitation.department_id, submittedAt, optIn ? 1 : 0, optIn ? encryptPii(body.contactPhone!) : null);
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
      branding: getTenantBranding(db, kiosk.tenant_id),
      questions
    });
  });

  router.post('/public/kiosk/:code/submit', publicSubmitLimiter, express.json({ limit: '64kb' }), (req: Request, res: Response) => {
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
  const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;

  router.post('/auth/login', loginLimiter, express.json({ limit: '8kb' }), (req: Request, res: Response) => {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password) {
      res.status(400).json({ error: 'missing_credentials' });
      return;
    }
    const user = db
      .prepare('SELECT id, password_hash, active, mfa_enabled FROM users WHERE email = ?')
      .get(email.toLowerCase().trim()) as { id: string; password_hash: string; active: number; mfa_enabled: number } | undefined;

    if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
      res.status(401).json({ error: 'invalid_credentials' });
      return;
    }

    if (user.mfa_enabled) {
      // Password verified, but the session isn't issued until the TOTP/recovery-code step
      // passes — a stolen password alone is not enough to get in.
      const rawChallenge = uid();
      const expiresAt = new Date(Date.now() + MFA_CHALLENGE_TTL_MS).toISOString();
      db.prepare('INSERT INTO mfa_challenges (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)').run(
        uid(),
        user.id,
        sha256(rawChallenge),
        expiresAt
      );
      res.json({ ok: true, mfaRequired: true, challengeToken: rawChallenge });
      return;
    }

    const { token, expiresAt } = createSession(db, user.id);
    setSessionCookie(res, token, expiresAt);
    logAudit(db, null, user.id, 'login', 'session', null, null);
    res.json({ ok: true, mfaRequired: false });
  });

  router.post('/auth/mfa/verify-login', loginLimiter, express.json({ limit: '8kb' }), async (req: Request, res: Response) => {
    const { challengeToken, code } = req.body as { challengeToken?: string; code?: string };
    if (!challengeToken || !code) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const challenge = db
      .prepare(
        `SELECT id, user_id FROM mfa_challenges WHERE token_hash = ? AND datetime(expires_at) > datetime('now')`
      )
      .get(sha256(challengeToken)) as { id: string; user_id: string } | undefined;
    if (!challenge) {
      res.status(401).json({ error: 'challenge_expired_or_invalid' });
      return;
    }
    const user = db
      .prepare('SELECT id, active, mfa_secret_encrypted, mfa_recovery_codes_json FROM users WHERE id = ?')
      .get(challenge.user_id) as
      | { id: string; active: number; mfa_secret_encrypted: string | null; mfa_recovery_codes_json: string | null }
      | undefined;
    if (!user || !user.active || !user.mfa_secret_encrypted) {
      res.status(401).json({ error: 'invalid_credentials' });
      return;
    }

    const secret = decryptPii(user.mfa_secret_encrypted)!;
    const codeIsValid = /^\d{6}$/.test(code) && (await verifyMfaToken(code, secret));
    if (codeIsValid) {
      db.prepare('DELETE FROM mfa_challenges WHERE id = ?').run(challenge.id);
      const { token, expiresAt } = createSession(db, user.id);
      setSessionCookie(res, token, expiresAt);
      logAudit(db, null, user.id, 'login_mfa', 'session', null, null);
      res.json({ ok: true });
      return;
    }
    // Not a valid TOTP code — try it as a one-time recovery code instead.
    const remaining = consumeRecoveryCode(user.mfa_recovery_codes_json, code);
    if (remaining) {
      db.prepare('UPDATE users SET mfa_recovery_codes_json = ? WHERE id = ?').run(JSON.stringify(remaining), user.id);
      db.prepare('DELETE FROM mfa_challenges WHERE id = ?').run(challenge.id);
      const { token, expiresAt } = createSession(db, user.id);
      setSessionCookie(res, token, expiresAt);
      logAudit(db, null, user.id, 'login_mfa_recovery_code', 'session', null, { remainingCodes: remaining.length });
      res.json({ ok: true, recoveryCodeUsed: true, remainingRecoveryCodes: remaining.length });
      return;
    }
    res.status(401).json({ error: 'invalid_code' });
  });

  router.post('/auth/mfa/enroll', requireAuth, async (req: Request, res: Response) => {
    const secret = await createMfaSecret();
    db.prepare('UPDATE users SET mfa_secret_encrypted = ?, mfa_enabled = 0, mfa_recovery_codes_json = NULL WHERE id = ?').run(
      encryptPii(secret),
      req.user!.id
    );
    const { otpauthUri, qrCodeDataUrl } = await buildEnrollmentQrCode(secret, req.user!.email);
    res.json({ secret, otpauthUri, qrCodeDataUrl });
  });

  router.post('/auth/mfa/verify-enrollment', requireAuth, express.json({ limit: '4kb' }), async (req: Request, res: Response) => {
    const { code } = req.body as { code?: string };
    if (!code || !/^\d{6}$/.test(code)) {
      res.status(400).json({ error: 'invalid_code' });
      return;
    }
    const row = db.prepare('SELECT mfa_secret_encrypted FROM users WHERE id = ?').get(req.user!.id) as
      | { mfa_secret_encrypted: string | null }
      | undefined;
    if (!row?.mfa_secret_encrypted) {
      res.status(409).json({ error: 'no_pending_enrollment' });
      return;
    }
    const secret = decryptPii(row.mfa_secret_encrypted)!;
    const valid = await verifyMfaToken(code, secret);
    if (!valid) {
      res.status(400).json({ error: 'invalid_code' });
      return;
    }
    const { rawCodes, hashedCodes } = generateRecoveryCodes();
    db.prepare('UPDATE users SET mfa_enabled = 1, mfa_recovery_codes_json = ? WHERE id = ?').run(
      JSON.stringify(hashedCodes),
      req.user!.id
    );
    logAudit(db, req.user!.tenantId, req.user!.id, 'mfa_enabled', 'user', req.user!.id, null);
    res.json({ ok: true, recoveryCodes: rawCodes });
  });

  router.post('/auth/mfa/disable', requireAuth, express.json({ limit: '4kb' }), (req: Request, res: Response) => {
    const { password } = req.body as { password?: string };
    const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user!.id) as { password_hash: string } | undefined;
    if (!password || !user || !verifyPassword(password, user.password_hash)) {
      res.status(401).json({ error: 'invalid_password' });
      return;
    }
    db.prepare('UPDATE users SET mfa_enabled = 0, mfa_secret_encrypted = NULL, mfa_recovery_codes_json = NULL WHERE id = ?').run(
      req.user!.id
    );
    logAudit(db, req.user!.tenantId, req.user!.id, 'mfa_disabled', 'user', req.user!.id, null);
    res.json({ ok: true });
  });

  const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;

  router.post('/auth/forgot-password', passwordResetLimiter, express.json({ limit: '8kb' }), async (req: Request, res: Response) => {
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

  router.post('/auth/reset-password', passwordResetLimiter, express.json({ limit: '8kb' }), (req: Request, res: Response) => {
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
  router.post('/webhooks/invitations', webhookLimiter, express.json({ limit: '256kb' }), async (req: Request, res: Response) => {
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
  router.post('/webhooks/episodes', webhookLimiter, express.json({ limit: '8kb' }), (req: Request, res: Response) => {
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

  router.post('/public/proms/:token/submit', publicSubmitLimiter, express.json({ limit: '16kb' }), (req: Request, res: Response) => {
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
  router.post('/public/proms/:token/opt-out', publicSubmitLimiter, (req: Request, res: Response) => {
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

  // -------------------------------------------------------------------------
  // Public employee experience/engagement survey (token is the identity; no auth, no
  // employee-identifying data ever accepted from this endpoint — see employee_survey_responses).
  // -------------------------------------------------------------------------
  router.get('/public/employee-survey/:token', (req: Request, res: Response) => {
    const invitation = db
      .prepare(
        `SELECT ei.id, ei.status, ei.expires_at, ei.instrument_id, esi.name_ar as instrument_name_ar,
                esi.name_en as instrument_name_en, esi.tenant_id
         FROM employee_survey_invitations ei
         JOIN employee_survey_instruments esi ON esi.id = ei.instrument_id
         WHERE ei.token_hash = ?`
      )
      .get(sha256(req.params.token)) as
      | { id: string; status: string; expires_at: string; instrument_id: string; instrument_name_ar: string; instrument_name_en: string; tenant_id: string }
      | undefined;
    if (!invitation) {
      res.status(404).json({ error: 'not_found' });
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
    const domains = db
      .prepare('SELECT id, name_ar, name_en FROM employee_survey_domains WHERE instrument_id = ?')
      .all(invitation.instrument_id) as { id: string; name_ar: string; name_en: string }[];
    const questions = db
      .prepare(
        `SELECT id, domain_id, text_ar, text_en, answer_type, sort_order FROM employee_survey_questions
         WHERE domain_id IN (SELECT id FROM employee_survey_domains WHERE instrument_id = ?) AND active = 1
         ORDER BY sort_order`
      )
      .all(invitation.instrument_id) as { id: string; domain_id: string; text_ar: string; text_en: string; answer_type: string; sort_order: number }[];
    res.json({
      instrumentNameAr: invitation.instrument_name_ar,
      instrumentNameEn: invitation.instrument_name_en,
      defaultLanguage: getTenantSmsConfig(db, invitation.tenant_id).defaultLanguage,
      branding: getTenantBranding(db, invitation.tenant_id),
      domains: domains.map((d) => ({
        id: d.id,
        nameAr: d.name_ar,
        nameEn: d.name_en,
        questions: questions
          .filter((q) => q.domain_id === d.id)
          .map((q) => ({ id: q.id, textAr: q.text_ar, textEn: q.text_en, answerType: q.answer_type }))
      }))
    });
  });

  router.post('/public/employee-survey/:token/submit', publicSubmitLimiter, express.json({ limit: '16kb' }), (req: Request, res: Response) => {
    const tokenHash = sha256(req.params.token);
    const invitation = db
      .prepare(
        `SELECT ei.id, ei.status, ei.expires_at, ei.instrument_id, ei.department_id, ei.job_category, esi.tenant_id
         FROM employee_survey_invitations ei
         JOIN employee_survey_instruments esi ON esi.id = ei.instrument_id
         WHERE ei.token_hash = ?`
      )
      .get(tokenHash) as
      | { id: string; status: string; expires_at: string; instrument_id: string; department_id: string | null; job_category: string; tenant_id: string }
      | undefined;
    if (!invitation) {
      res.status(404).json({ error: 'not_found' });
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
    const validQuestions = db
      .prepare(
        `SELECT id, answer_type FROM employee_survey_questions
         WHERE domain_id IN (SELECT id FROM employee_survey_domains WHERE instrument_id = ?) AND active = 1`
      )
      .all(invitation.instrument_id) as { id: string; answer_type: string }[];
    const answerTypeById = new Map(validQuestions.map((q) => [q.id, q.answer_type]));
    // Open-ended questions (answer_type 'text') are optional — the hospital's own instrument
    // sees a meaningfully lower response rate on its three open questions than on the scored
    // items, so submission only requires every non-text question to be answered.
    const requiredQuestionIds = new Set(validQuestions.filter((q) => q.answer_type !== 'text').map((q) => q.id));

    const body = req.body as { answers?: { questionId: string; value?: number; text?: string }[] };
    if (!Array.isArray(body.answers) || body.answers.length === 0) {
      res.status(400).json({ error: 'invalid_answers' });
      return;
    }
    const numericAnswers: { questionId: string; value: number }[] = [];
    const textAnswers: { questionId: string; text: string }[] = [];
    for (const answer of body.answers) {
      const answerType = answerTypeById.get(answer.questionId);
      if (!answerType) continue;
      if (answerType === 'text') {
        if (typeof answer.text === 'string' && answer.text.trim()) textAnswers.push({ questionId: answer.questionId, text: answer.text.trim() });
      } else if (typeof answer.value === 'number' && Number.isFinite(answer.value)) {
        numericAnswers.push({ questionId: answer.questionId, value: answer.value });
      }
    }
    const requiredAnswered = new Set(numericAnswers.map((a) => a.questionId));
    const missingRequired = [...requiredQuestionIds].some((id) => !requiredAnswered.has(id));
    if (missingRequired) {
      res.status(400).json({ error: 'incomplete_answers' });
      return;
    }

    // Deliberately no employee_id / invitation_id stored on the response — see
    // employee_survey_responses in db.ts. Only the department/job-category tags snapshotted
    // on the invitation carry over, severing the identity link at submission time.
    const responseId = uid();
    db.prepare(
      'INSERT INTO employee_survey_responses (id, tenant_id, instrument_id, department_id, job_category, submitted_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(responseId, invitation.tenant_id, invitation.instrument_id, invitation.department_id, invitation.job_category, new Date().toISOString());
    const insertNumericAnswer = db.prepare('INSERT INTO employee_survey_answers (id, response_id, question_id, value_numeric) VALUES (?, ?, ?, ?)');
    for (const answer of numericAnswers) {
      insertNumericAnswer.run(uid(), responseId, answer.questionId, answer.value);
    }
    const insertTextAnswer = db.prepare('INSERT INTO employee_survey_answers (id, response_id, question_id, value_text) VALUES (?, ?, ?, ?)');
    for (const answer of textAnswers) {
      insertTextAnswer.run(uid(), responseId, answer.questionId, answer.text);
    }
    db.prepare("UPDATE employee_survey_invitations SET status = 'completed' WHERE id = ?").run(invitation.id);

    res.status(201).json({ ok: true });
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
        `SELECT id, code, name_ar, name_en, service_type, benchmark_top_box_percent, target_top_box_percent, active, is_ancillary FROM question_domains
         WHERE tenant_id = ? ${includeInactive ? '' : 'AND active = 1'}`
      )
      .all(req.user!.tenantId);
    const questions = db
      .prepare(
        `SELECT id, code, domain_id, text_ar, text_en, answer_type, service_type, requires_alert, active, is_custom, cahps_item FROM questions
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
      const { nameAr, nameEn, benchmarkTopBoxPercent, targetTopBoxPercent, active } = req.body as {
        nameAr?: string;
        nameEn?: string;
        benchmarkTopBoxPercent?: number;
        targetTopBoxPercent?: number | null;
        active?: boolean;
      };
      if (nameAr !== undefined) db.prepare('UPDATE question_domains SET name_ar = ? WHERE id = ?').run(nameAr, req.params.id);
      if (nameEn !== undefined) db.prepare('UPDATE question_domains SET name_en = ? WHERE id = ?').run(nameEn, req.params.id);
      if (benchmarkTopBoxPercent !== undefined)
        db.prepare('UPDATE question_domains SET benchmark_top_box_percent = ? WHERE id = ?').run(benchmarkTopBoxPercent, req.params.id);
      if (targetTopBoxPercent !== undefined)
        db.prepare('UPDATE question_domains SET target_top_box_percent = ? WHERE id = ?').run(targetTopBoxPercent, req.params.id);
      if (active !== undefined) db.prepare('UPDATE question_domains SET active = ? WHERE id = ?').run(active ? 1 : 0, req.params.id);
      logAudit(db, req.user!.tenantId, req.user!.id, 'domain_updated', 'question_domain', req.params.id, req.body);
      res.json({ ok: true });
    }
  );

  router.post('/question-bank/questions', requireRole('SystemAdmin'), express.json({ limit: '8kb' }), (req: Request, res: Response) => {
    const { code, domainId, textAr, textEn, type, requiresAlert, dependsOnCode, isCustom, cahpsItem } = req.body as {
      code?: string;
      domainId?: string;
      textAr?: string;
      textEn?: string;
      type?: AnswerType;
      requiresAlert?: boolean;
      dependsOnCode?: string;
      isCustom?: boolean;
      cahpsItem?: boolean;
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
         (id, tenant_id, code, domain_id, text_ar, text_en, answer_type, service_type, requires_alert, sort_order, depends_on_code, is_custom, cahps_item)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        // Admin-created questions default to "custom" (dagger-marked in reports) since they are
        // local additions, not part of the standardized core bank — the admin can override this.
      ).run(
        id,
        req.user!.tenantId,
        code,
        domainId,
        textAr,
        textEn,
        type,
        domain.service_type,
        requiresAlert ? 1 : 0,
        nextSortOrder,
        dependsOnCode ?? null,
        isCustom === false ? 0 : 1,
        cahpsItem ? 1 : 0
      );
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
      const { textAr, textEn, requiresAlert, active, isCustom, cahpsItem } = req.body as {
        textAr?: string;
        textEn?: string;
        requiresAlert?: boolean;
        active?: boolean;
        isCustom?: boolean;
        cahpsItem?: boolean;
      };
      if (textAr !== undefined) db.prepare('UPDATE questions SET text_ar = ? WHERE id = ?').run(textAr, req.params.id);
      if (textEn !== undefined) db.prepare('UPDATE questions SET text_en = ? WHERE id = ?').run(textEn, req.params.id);
      if (requiresAlert !== undefined) db.prepare('UPDATE questions SET requires_alert = ? WHERE id = ?').run(requiresAlert ? 1 : 0, req.params.id);
      if (active !== undefined) db.prepare('UPDATE questions SET active = ? WHERE id = ?').run(active ? 1 : 0, req.params.id);
      if (isCustom !== undefined) db.prepare('UPDATE questions SET is_custom = ? WHERE id = ?').run(isCustom ? 1 : 0, req.params.id);
      if (cahpsItem !== undefined) db.prepare('UPDATE questions SET cahps_item = ? WHERE id = ?').run(cahpsItem ? 1 : 0, req.params.id);
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
    const existing = db.prepare('SELECT id, role FROM users WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user!.tenantId) as
      | { id: string; role: Role }
      | undefined;
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
      // A DepartmentManager with no department bypasses departmentScopeFilter() entirely
      // (it only scopes when departmentId is truthy) and would see every department's data —
      // this must be impossible to create, matching the same check already enforced on POST /users.
      if (role === 'DepartmentManager' && !departmentId) {
        res.status(400).json({ error: 'department_required_for_department_manager' });
        return;
      }
      db.prepare('UPDATE users SET role = ?, department_id = ? WHERE id = ?').run(
        role,
        role === 'DepartmentManager' ? departmentId ?? null : null,
        req.params.id
      );
    } else if (departmentId !== undefined) {
      if (existing.role === 'DepartmentManager' && !departmentId) {
        res.status(400).json({ error: 'department_required_for_department_manager' });
        return;
      }
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

  // Shared helper: raw numeric answer values for one question, optionally scoped to a
  // department and/or a submission-date window. Reused by scores/trend/priority-index/
  // departments-breakdown so each report view stays consistent with the others.
  function fetchQuestionValues(
    tenantId: string,
    questionId: string,
    deptId: string | null | undefined,
    dateFrom?: string,
    dateTo?: string
  ): number[] {
    const params: string[] = [questionId, tenantId];
    let sql = `SELECT a.value_numeric as v FROM answers a
               JOIN survey_responses r ON r.id = a.response_id
               WHERE a.question_id = ? AND r.tenant_id = ?`;
    if (deptId) {
      sql += ' AND EXISTS (SELECT 1 FROM survey_invitations si WHERE si.id = r.invitation_id AND si.department_id = ?)';
      params.push(deptId);
    }
    if (dateFrom) {
      sql += ' AND r.submitted_at >= ?';
      params.push(dateFrom);
    }
    if (dateTo) {
      sql += ' AND r.submitted_at < ?';
      params.push(dateTo);
    }
    return (db.prepare(sql).all(...params) as { v: number }[]).map((r) => r.v);
  }

  // RAG status for a domain's current score against its admin-set target (ANL-11): green once
  // the target is met, amber within 5 points below it, red further behind. No status without
  // both a target and enough data to score.
  const TARGET_NEAR_MARGIN_POINTS = 5;
  function targetStatus(topBoxPercent: number | null, target: number | null): 'met' | 'near' | 'below' | null {
    if (topBoxPercent == null || target == null) return null;
    if (topBoxPercent >= target) return 'met';
    if (topBoxPercent >= target - TARGET_NEAR_MARGIN_POINTS) return 'near';
    return 'below';
  }

  /** A single number summarizing one answer type, matching each type's primary reported metric. */
  function primaryMetric(answerType: AnswerType, values: number[]): number | null {
    if (answerType === 'nps') return scoreNps(values).score;
    if (answerType === 'yesno') return scoreYesNo(values).yesPercent;
    if (answerType === 'likert5') return scoreQuestion('', values).topBoxPercent;
    return null;
  }

  // Rolling 3-month windows (not calendar quarters) used for "vs last period" / "12-month
  // change" deltas, so the comparison always has a full window of data regardless of today's date.
  function rollingWindows(): { curFrom: string; curTo: string; prevFrom: string; prevTo: string; yearFrom: string; yearTo: string } {
    const now = new Date();
    const iso = (d: Date) => d.toISOString();
    const curTo = now;
    const curFrom = new Date(now);
    curFrom.setMonth(curFrom.getMonth() - 3);
    const prevFrom = new Date(now);
    prevFrom.setMonth(prevFrom.getMonth() - 6);
    const yearTo = new Date(now);
    yearTo.setMonth(yearTo.getMonth() - 12);
    const yearFrom = new Date(now);
    yearFrom.setMonth(yearFrom.getMonth() - 15);
    return { curFrom: iso(curFrom), curTo: iso(curTo), prevFrom: iso(prevFrom), prevTo: iso(curFrom), yearFrom: iso(yearFrom), yearTo: iso(yearTo) };
  }

  router.get('/reports/scores', (req: Request, res: Response) => {
    const serviceType = req.query.serviceType as ServiceType | undefined;
    const departmentId = req.query.departmentId as string | undefined;

    if (req.user!.role === 'DepartmentManager' && departmentId && departmentId !== req.user!.departmentId) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const effectiveDeptId = req.user!.role === 'DepartmentManager' ? req.user!.departmentId : departmentId;
    const windows = rollingWindows();

    const domains = db
      .prepare(
        `SELECT id, code, name_ar, name_en, service_type, benchmark_top_box_percent, target_top_box_percent FROM question_domains
         WHERE tenant_id = ? AND active = 1 AND (? IS NULL OR service_type = ?)`
      )
      .all(req.user!.tenantId, serviceType ?? null, serviceType ?? null) as {
      id: string;
      code: string;
      name_ar: string;
      name_en: string;
      service_type: string;
      benchmark_top_box_percent: number;
      target_top_box_percent: number | null;
    }[];

    const results = domains.map((domain) => {
      const questions = db
        .prepare(
          'SELECT id, code, text_ar, text_en, answer_type, is_custom, cahps_item FROM questions WHERE domain_id = ? AND active = 1 ORDER BY sort_order'
        )
        .all(domain.id) as {
        id: string;
        code: string;
        text_ar: string;
        text_en: string;
        answer_type: AnswerType;
        is_custom: number;
        cahps_item: number;
      }[];

      const questionScores = questions.map((q) => {
        const values = fetchQuestionValues(req.user!.tenantId, q.id, effectiveDeptId);
        const isCustom = q.is_custom === 1;
        const cahpsItem = q.cahps_item === 1;

        const curValues = fetchQuestionValues(req.user!.tenantId, q.id, effectiveDeptId, windows.curFrom, windows.curTo);
        const prevValues = fetchQuestionValues(req.user!.tenantId, q.id, effectiveDeptId, windows.prevFrom, windows.prevTo);
        const yearAgoValues = fetchQuestionValues(req.user!.tenantId, q.id, effectiveDeptId, windows.yearFrom, windows.yearTo);
        const curMetric = primaryMetric(q.answer_type, curValues);
        const prevMetric = primaryMetric(q.answer_type, prevValues);
        const yearAgoMetric = primaryMetric(q.answer_type, yearAgoValues);
        const vsLastPeriod = curMetric != null && prevMetric != null ? round2(curMetric - prevMetric) : null;
        const vs12MonthsAgo = curMetric != null && yearAgoMetric != null ? round2(curMetric - yearAgoMetric) : null;
        const distribution = q.answer_type === 'likert5' ? scoreDistribution(values) : null;

        const base = { ...q, isCustom, cahpsItem, distribution, vsLastPeriod, vs12MonthsAgo };
        if (q.answer_type === 'nps') {
          const nps = scoreNps(values);
          return { ...base, n: nps.n, mean: null, topBoxPercent: null, npsScore: nps.score, yesPercent: null };
        }
        if (q.answer_type === 'yesno') {
          const yesNo = scoreYesNo(values);
          return { ...base, n: yesNo.n, mean: null, topBoxPercent: null, npsScore: null, yesPercent: yesNo.yesPercent };
        }
        const score = scoreQuestion(q.id, values);
        return { ...base, ...score, npsScore: null, yesPercent: null };
      });

      const allDomainValues = questionScores
        .filter((q) => q.answer_type !== 'nps' && q.answer_type !== 'yesno')
        .flatMap((q) => fetchQuestionValues(req.user!.tenantId, q.id, effectiveDeptId));

      const domainScore = scoreDomain(domain.id, allDomainValues, domain.benchmark_top_box_percent);
      const benchmarks = db
        .prepare('SELECT peer_group_name as peerGroupName, value FROM external_benchmarks WHERE domain_id = ? ORDER BY peer_group_name')
        .all(domain.id) as { peerGroupName: string; value: number }[];

      return {
        domain: { id: domain.id, code: domain.code, nameAr: domain.name_ar, nameEn: domain.name_en, serviceType: domain.service_type },
        score: domainScore,
        targetTopBoxPercent: domain.target_top_box_percent,
        targetStatus: targetStatus(domainScore.topBoxPercent, domain.target_top_box_percent),
        benchmarks,
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

  // Domain-level score summary as CSV/Excel (RFP ANL-09) — the same domain scores shown on the
  // Reports page, flattened to one row per domain rather than the full per-question JSON tree.
  router.get('/reports/scores/export', async (req: Request, res: Response) => {
    const format = req.query.format === 'xlsx' ? 'xlsx' : 'csv';
    const serviceType = req.query.serviceType as ServiceType | undefined;
    const departmentId = req.query.departmentId as string | undefined;
    if (req.user!.role === 'DepartmentManager' && departmentId && departmentId !== req.user!.departmentId) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const effectiveDeptId = req.user!.role === 'DepartmentManager' ? req.user!.departmentId : departmentId;

    const domains = db
      .prepare(
        `SELECT id, code, name_ar, name_en, service_type, benchmark_top_box_percent, target_top_box_percent FROM question_domains
         WHERE tenant_id = ? AND active = 1 AND (? IS NULL OR service_type = ?)`
      )
      .all(req.user!.tenantId, serviceType ?? null, serviceType ?? null) as {
      id: string;
      code: string;
      name_ar: string;
      name_en: string;
      service_type: string;
      benchmark_top_box_percent: number;
      target_top_box_percent: number | null;
    }[];

    const headers = [
      'المحور',
      'الرمز',
      'الخدمة',
      'عدد الاستجابات',
      'المتوسط',
      'نسبة Top-Box %',
      'المعيار المرجعي %',
      'الفرق (نقطة مئوية)',
      'المستهدف %',
      'حالة المستهدف'
    ];
    const TARGET_STATUS_LABELS_AR: Record<'met' | 'near' | 'below', string> = { met: 'محقَّق', near: 'قريب', below: 'دون المستهدف' };
    const rows: ExportCell[][] = domains.map((domain) => {
      // Only likert5 questions feed the pooled domain score — nps/yesno items have a different
      // scale and are excluded here the same way /reports/scores excludes them (allDomainValues).
      const likertQuestionIds = (
        db.prepare("SELECT id FROM questions WHERE domain_id = ? AND active = 1 AND answer_type = 'likert5'").all(domain.id) as { id: string }[]
      ).map((q) => q.id);
      const allValues = likertQuestionIds.flatMap((qId) => fetchQuestionValues(req.user!.tenantId, qId, effectiveDeptId));
      const score = scoreDomain(domain.id, allValues, domain.benchmark_top_box_percent);
      const status = targetStatus(score.topBoxPercent, domain.target_top_box_percent);
      return [
        domain.name_ar,
        domain.code,
        domain.service_type,
        score.n,
        score.mean,
        score.topBoxPercent,
        domain.benchmark_top_box_percent,
        score.diffPercentPoints,
        domain.target_top_box_percent,
        status ? TARGET_STATUS_LABELS_AR[status] : null
      ];
    });

    if (format === 'xlsx') await sendXlsx(res, 'tajruba-scores', 'المحاور', headers, rows);
    else sendCsv(res, 'tajruba-scores', headers, rows);
  });

  const TREND_PERIOD_EXPR: Record<'day' | 'month' | 'quarter' | 'half' | 'year', string> = {
    day: "strftime('%Y-%m-%d', r.submitted_at)",
    month: "strftime('%Y-%m', r.submitted_at)",
    quarter: "strftime('%Y', r.submitted_at) || '-Q' || ((CAST(strftime('%m', r.submitted_at) AS INTEGER) - 1) / 3 + 1)",
    half: "strftime('%Y', r.submitted_at) || '-H' || ((CAST(strftime('%m', r.submitted_at) AS INTEGER) - 1) / 6 + 1)",
    year: "strftime('%Y', r.submitted_at)"
  };

  router.get('/reports/trend', (req: Request, res: Response) => {
    const serviceType = req.query.serviceType as ServiceType | undefined;
    const departmentId = req.user!.role === 'DepartmentManager' ? req.user!.departmentId : (req.query.departmentId as string | undefined);
    const periodParam = req.query.period as string | undefined;
    // A custom date range (from/to) implies day-level bucketing unless the caller explicitly
    // asked for a coarser one (e.g. month buckets within a custom multi-year range).
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;
    const defaultPeriod = from || to ? 'day' : 'month';
    const period = periodParam && periodParam in TREND_PERIOD_EXPR ? (periodParam as keyof typeof TREND_PERIOD_EXPR) : defaultPeriod;
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
         ${from ? 'AND r.submitted_at >= ?' : ''}
         ${to ? 'AND r.submitted_at < ?' : ''}
         GROUP BY period ORDER BY period`
      )
      .all(
        ...[
          req.user!.tenantId,
          ...(serviceType ? [serviceType] : []),
          ...(departmentId ? [departmentId] : []),
          ...(from ? [from] : []),
          ...(to ? [to] : [])
        ]
      ) as { period: string; mean: number; topBoxPercent: number; n: number }[];

    res.json({
      period,
      trend: rows.map((r) => ({ ...r, mean: round2(r.mean), topBoxPercent: round2(r.topBoxPercent) }))
    });
  });

  // Priority Index: ranks questions by how strongly they correlate with the service's overall
  // rating question, combined with sample size — a driver/impact analysis matching the
  // "high-importance, low-performance" table found in external PREMs reports. There is no
  // stored "overall" flag; each service's Overall Assessment domain (code ending "_OVR")
  // contains a likert5 "overall rating" item that serves as the criterion variable.
  router.get('/reports/priority-index', (req: Request, res: Response) => {
    const serviceType = req.query.serviceType as ServiceType | undefined;
    const departmentId = req.query.departmentId as string | undefined;
    if (!serviceType) {
      res.status(400).json({ error: 'service_type_required' });
      return;
    }
    if (req.user!.role === 'DepartmentManager' && departmentId && departmentId !== req.user!.departmentId) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const effectiveDeptId = req.user!.role === 'DepartmentManager' ? req.user!.departmentId : departmentId;

    const overallDomain = db
      .prepare("SELECT id FROM question_domains WHERE tenant_id = ? AND service_type = ? AND code LIKE '%\\_OVR' ESCAPE '\\'")
      .get(req.user!.tenantId, serviceType) as { id: string } | undefined;
    const criterionQuestion = overallDomain
      ? (db
          .prepare("SELECT id FROM questions WHERE domain_id = ? AND answer_type = 'likert5' AND active = 1 ORDER BY sort_order LIMIT 1")
          .get(overallDomain.id) as { id: string } | undefined)
      : undefined;
    if (!criterionQuestion) {
      res.json({ criterionQuestionId: null, items: [] });
      return;
    }

    const candidates = db
      .prepare(
        `SELECT q.id, q.code, q.text_ar, q.text_en, q.answer_type, q.is_custom, q.cahps_item,
                d.name_ar as domain_name_ar, d.name_en as domain_name_en
         FROM questions q JOIN question_domains d ON d.id = q.domain_id
         WHERE q.tenant_id = ? AND q.service_type = ? AND q.active = 1 AND q.id != ?`
      )
      .all(req.user!.tenantId, serviceType, criterionQuestion.id) as {
      id: string;
      code: string;
      text_ar: string;
      text_en: string;
      answer_type: AnswerType;
      is_custom: number;
      cahps_item: number;
      domain_name_ar: string;
      domain_name_en: string;
    }[];

    const items = candidates
      .map((q) => {
        let sql = `SELECT a_cand.value_numeric as x, a_crit.value_numeric as y
                    FROM answers a_cand
                    JOIN answers a_crit ON a_crit.response_id = a_cand.response_id AND a_crit.question_id = ?
                    JOIN survey_responses r ON r.id = a_cand.response_id
                    WHERE a_cand.question_id = ? AND r.tenant_id = ?`;
        const params: string[] = [criterionQuestion.id, q.id, req.user!.tenantId];
        if (effectiveDeptId) {
          sql += ' AND EXISTS (SELECT 1 FROM survey_invitations si WHERE si.id = r.invitation_id AND si.department_id = ?)';
          params.push(effectiveDeptId);
        }
        const rows = db.prepare(sql).all(...params) as { x: number; y: number }[];
        const correlation = pearsonCorrelation(rows.map((r) => [r.x, r.y] as [number, number]));
        const values = rows.map((r) => r.x);
        const n = values.length;
        const mean = primaryMetric(q.answer_type, values);
        return {
          id: q.id,
          code: q.code,
          textAr: q.text_ar,
          textEn: q.text_en,
          answerType: q.answer_type,
          isCustom: q.is_custom === 1,
          cahpsItem: q.cahps_item === 1,
          domainNameAr: q.domain_name_ar,
          domainNameEn: q.domain_name_en,
          n,
          mean,
          correlation
        };
      })
      .filter((item) => item.correlation != null && item.n >= SMALL_SAMPLE_THRESHOLD)
      .sort((a, b) => (b.correlation ?? 0) - (a.correlation ?? 0))
      .slice(0, 15);

    res.json({ criterionQuestionId: criterionQuestion.id, items });
  });

  // Departments/units breakdown + variance analysis: compares every department within one
  // service line on the same "overall rating" criterion question, for identifying units that
  // are above/below the organizational average and improving/declining vs. the last period —
  // matching external reports' Units Breakdown + Variance Analysis quadrant view. A
  // DepartmentManager never sees other departments anywhere else in the app, so this
  // cross-department comparison is restricted to roles that already have that visibility.
  // Case-mix adjustment (RFP BMK-04) via indirect standardization on patient age band — the
  // same technique HCAHPS itself uses (among other covariates) to compare units fairly when
  // they serve different patient populations. Age band is the one covariate this platform
  // captures (see AgeBand in types.ts); departments/periods with no age-band data on file simply
  // get no adjusted figure rather than a misleading one.
  function ageBandTopBoxRates(
    tenantId: string,
    questionId: string,
    deptId: string | undefined,
    dateFrom: string,
    dateTo: string
  ): Map<string, { n: number; topBoxRate: number }> {
    let sql = `SELECT si.patient_age_band as band, COUNT(*) as n, AVG(CASE WHEN a.value_numeric >= 5 THEN 1.0 ELSE 0.0 END) as rate
               FROM answers a
               JOIN survey_responses r ON r.id = a.response_id
               JOIN survey_invitations si ON si.id = r.invitation_id
               WHERE a.question_id = ? AND r.tenant_id = ? AND si.patient_age_band IS NOT NULL
                     AND r.submitted_at >= ? AND r.submitted_at < ?`;
    const params: string[] = [questionId, tenantId, dateFrom, dateTo];
    if (deptId) {
      sql += ' AND si.department_id = ?';
      params.push(deptId);
    }
    sql += ' GROUP BY si.patient_age_band';
    const rows = db.prepare(sql).all(...params) as { band: string; n: number; rate: number }[];
    return new Map(rows.map((r) => [r.band, { n: r.n, topBoxRate: r.rate }]));
  }

  /**
   * Expected Top-Box rate for this department if it had the org's overall age-band-specific
   * rates but its OWN age-band mix (indirect standardization), then the department's raw rate
   * is scaled by (org overall rate / expected rate) to produce a mix-adjusted figure comparable
   * across departments regardless of who they happen to serve. Returns null when there isn't
   * enough age-band data on file to standardize against (no adjustment silently applied).
   */
  function caseMixAdjustedTopBoxPercent(
    tenantId: string,
    questionId: string,
    deptId: string,
    dateFrom: string,
    dateTo: string,
    orgRates: Map<string, { n: number; topBoxRate: number }>,
    orgOverallRate: number | null
  ): number | null {
    if (orgOverallRate == null) return null;
    const deptRates = ageBandTopBoxRates(tenantId, questionId, deptId, dateFrom, dateTo);
    const deptTotalN = [...deptRates.values()].reduce((sum, v) => sum + v.n, 0);
    if (deptTotalN === 0) return null;
    let expectedSum = 0;
    for (const [band, deptStat] of deptRates) {
      const orgStat = orgRates.get(band);
      if (orgStat) expectedSum += deptStat.n * orgStat.topBoxRate;
    }
    const expectedRate = expectedSum / deptTotalN;
    if (expectedRate <= 0) return null;
    const observedRate = [...deptRates.values()].reduce((sum, v) => sum + v.n * v.topBoxRate, 0) / deptTotalN;
    const adjustedRate = observedRate * (orgOverallRate / expectedRate);
    return round2(Math.min(100, Math.max(0, adjustedRate * 100)));
  }

  router.get('/reports/departments-breakdown', (req: Request, res: Response) => {
    const serviceType = req.query.serviceType as ServiceType | undefined;
    if (!serviceType) {
      res.status(400).json({ error: 'service_type_required' });
      return;
    }
    if (req.user!.role === 'DepartmentManager') {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    const overallDomain = db
      .prepare("SELECT id FROM question_domains WHERE tenant_id = ? AND service_type = ? AND code LIKE '%\\_OVR' ESCAPE '\\'")
      .get(req.user!.tenantId, serviceType) as { id: string } | undefined;
    const criterionQuestion = overallDomain
      ? (db
          .prepare("SELECT id FROM questions WHERE domain_id = ? AND answer_type = 'likert5' AND active = 1 ORDER BY sort_order LIMIT 1")
          .get(overallDomain.id) as { id: string } | undefined)
      : undefined;
    if (!criterionQuestion) {
      res.json({ orgAverageTopBoxPercent: null, departments: [] });
      return;
    }

    const departments = db
      .prepare('SELECT id, name_ar, name_en FROM departments WHERE tenant_id = ? AND service_type = ? AND active = 1')
      .all(req.user!.tenantId, serviceType) as { id: string; name_ar: string; name_en: string }[];

    const windows = rollingWindows();
    const orgCurrentValues = fetchQuestionValues(req.user!.tenantId, criterionQuestion.id, undefined, windows.curFrom, windows.curTo);
    const orgAvg = primaryMetric('likert5', orgCurrentValues);
    const orgAgeBandRates = ageBandTopBoxRates(req.user!.tenantId, criterionQuestion.id, undefined, windows.curFrom, windows.curTo);
    const orgOverallRate = orgAvg == null ? null : orgAvg / 100;
    const monthExpr = TREND_PERIOD_EXPR.month;

    const results = departments.map((dept) => {
      const curValues = fetchQuestionValues(req.user!.tenantId, criterionQuestion.id, dept.id, windows.curFrom, windows.curTo);
      const prevValues = fetchQuestionValues(req.user!.tenantId, criterionQuestion.id, dept.id, windows.prevFrom, windows.prevTo);
      const curMetric = primaryMetric('likert5', curValues);
      const prevMetric = primaryMetric('likert5', prevValues);
      const change = curMetric != null && prevMetric != null ? round2(curMetric - prevMetric) : null;
      const deviation = curMetric != null && orgAvg != null ? round2(curMetric - orgAvg) : null;
      const caseMixAdjusted = caseMixAdjustedTopBoxPercent(
        req.user!.tenantId,
        criterionQuestion.id,
        dept.id,
        windows.curFrom,
        windows.curTo,
        orgAgeBandRates,
        orgOverallRate
      );

      const sparkRows = db
        .prepare(
          `SELECT ${monthExpr} as period, AVG(CASE WHEN a.value_numeric >= 5 THEN 100.0 ELSE 0.0 END) as topBoxPercent, COUNT(*) as n
           FROM answers a
           JOIN survey_responses r ON r.id = a.response_id
           JOIN survey_invitations si ON si.id = r.invitation_id
           WHERE a.question_id = ? AND r.tenant_id = ? AND si.department_id = ?
           GROUP BY period ORDER BY period DESC LIMIT 6`
        )
        .all(criterionQuestion.id, req.user!.tenantId, dept.id) as { period: string; topBoxPercent: number; n: number }[];
      const trend = sparkRows.reverse().map((r) => ({ period: r.period, topBoxPercent: round2(r.topBoxPercent), n: r.n }));

      return {
        departmentId: dept.id,
        departmentNameAr: dept.name_ar,
        departmentNameEn: dept.name_en,
        n: curValues.length,
        currentTopBoxPercent: curMetric,
        previousTopBoxPercent: prevMetric,
        changeVsPreviousPeriod: change,
        deviationVsOrgAverage: deviation,
        caseMixAdjustedTopBoxPercent: caseMixAdjusted,
        trend
      };
    });

    // Internal percentile rank among this tenant's own departments for the same service line —
    // NOT a percentile against an external peer-group database (we have no such live feed). The
    // fraction of same-service departments this one is at or above, expressed as 0-100.
    const scored = results.filter((r) => r.currentTopBoxPercent != null);
    const withPercentile = results.map((r) => {
      if (r.currentTopBoxPercent == null || scored.length <= 1) return { ...r, percentileRank: null as number | null };
      const atOrBelow = scored.filter((o) => (o.currentTopBoxPercent as number) <= (r.currentTopBoxPercent as number)).length;
      return { ...r, percentileRank: round2((atOrBelow / scored.length) * 100) };
    });

    res.json({ orgAverageTopBoxPercent: orgAvg, smallSampleThreshold: SMALL_SAMPLE_THRESHOLD, departments: withPercentile });
  });

  // Departments breakdown as CSV/Excel (RFP ANL-09) — reuses the exact same criterion-question
  // and rolling-window logic as /reports/departments-breakdown above, flattened for export.
  router.get('/reports/departments-breakdown/export', async (req: Request, res: Response) => {
    const format = req.query.format === 'xlsx' ? 'xlsx' : 'csv';
    const serviceType = req.query.serviceType as ServiceType | undefined;
    if (!serviceType) {
      res.status(400).json({ error: 'service_type_required' });
      return;
    }
    if (req.user!.role === 'DepartmentManager') {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const overallDomain = db
      .prepare("SELECT id FROM question_domains WHERE tenant_id = ? AND service_type = ? AND code LIKE '%\\_OVR' ESCAPE '\\'")
      .get(req.user!.tenantId, serviceType) as { id: string } | undefined;
    const criterionQuestion = overallDomain
      ? (db
          .prepare("SELECT id FROM questions WHERE domain_id = ? AND answer_type = 'likert5' AND active = 1 ORDER BY sort_order LIMIT 1")
          .get(overallDomain.id) as { id: string } | undefined)
      : undefined;

    const headers = [
      'القسم',
      'عدد الاستجابات',
      'نسبة Top-Box الحالية %',
      'الفترة السابقة %',
      'التغير',
      'الانحراف عن متوسط المنشأة',
      'الترتيب المئيني الداخلي',
      'نسبة معدَّلة حسب الحالة (Case-mix) %'
    ];
    let rows: ExportCell[][] = [];
    if (criterionQuestion) {
      const departments = db
        .prepare('SELECT id, name_ar FROM departments WHERE tenant_id = ? AND service_type = ? AND active = 1')
        .all(req.user!.tenantId, serviceType) as { id: string; name_ar: string }[];
      const windows = rollingWindows();
      const orgCurrentValues = fetchQuestionValues(req.user!.tenantId, criterionQuestion.id, undefined, windows.curFrom, windows.curTo);
      const orgAvg = primaryMetric('likert5', orgCurrentValues);
      const orgAgeBandRates = ageBandTopBoxRates(req.user!.tenantId, criterionQuestion.id, undefined, windows.curFrom, windows.curTo);
      const orgOverallRate = orgAvg == null ? null : orgAvg / 100;

      const computed = departments.map((dept) => {
        const curValues = fetchQuestionValues(req.user!.tenantId, criterionQuestion.id, dept.id, windows.curFrom, windows.curTo);
        const prevValues = fetchQuestionValues(req.user!.tenantId, criterionQuestion.id, dept.id, windows.prevFrom, windows.prevTo);
        const curMetric = primaryMetric('likert5', curValues);
        const prevMetric = primaryMetric('likert5', prevValues);
        const caseMixAdjusted = caseMixAdjustedTopBoxPercent(
          req.user!.tenantId,
          criterionQuestion.id,
          dept.id,
          windows.curFrom,
          windows.curTo,
          orgAgeBandRates,
          orgOverallRate
        );
        return {
          nameAr: dept.name_ar,
          n: curValues.length,
          curMetric,
          prevMetric,
          change: curMetric != null && prevMetric != null ? round2(curMetric - prevMetric) : null,
          deviation: curMetric != null && orgAvg != null ? round2(curMetric - orgAvg) : null,
          caseMixAdjusted
        };
      });
      const scored = computed.filter((r) => r.curMetric != null);
      rows = computed.map((r) => {
        const percentile =
          r.curMetric == null || scored.length <= 1
            ? null
            : round2((scored.filter((o) => (o.curMetric as number) <= (r.curMetric as number)).length / scored.length) * 100);
        return [r.nameAr, r.n, r.curMetric, r.prevMetric, r.change, r.deviation, percentile, r.caseMixAdjusted];
      });
    }

    if (format === 'xlsx') await sendXlsx(res, 'tajruba-departments', 'الأقسام', headers, rows);
    else sendCsv(res, 'tajruba-departments', headers, rows);
  });

  // Greatest movers: the questions with the largest positive/negative change vs the last rolling
  // period, optionally scoped to one department — matches the "Greatest Increases"/"Greatest
  // Declines" tables shown per-unit in external PREMs reports.
  router.get('/reports/movers', (req: Request, res: Response) => {
    const serviceType = req.query.serviceType as ServiceType | undefined;
    const departmentId = req.query.departmentId as string | undefined;
    if (!serviceType) {
      res.status(400).json({ error: 'service_type_required' });
      return;
    }
    if (req.user!.role === 'DepartmentManager' && departmentId && departmentId !== req.user!.departmentId) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const effectiveDeptId = req.user!.role === 'DepartmentManager' ? req.user!.departmentId : departmentId;
    const windows = rollingWindows();

    const questions = db
      .prepare(
        `SELECT q.id, q.code, q.text_ar, q.answer_type, q.is_custom, d.name_ar as domain_name_ar
         FROM questions q JOIN question_domains d ON d.id = q.domain_id
         WHERE q.tenant_id = ? AND q.service_type = ? AND q.active = 1`
      )
      .all(req.user!.tenantId, serviceType) as {
      id: string;
      code: string;
      text_ar: string;
      answer_type: AnswerType;
      is_custom: number;
      domain_name_ar: string;
    }[];

    const movers = questions
      .map((q) => {
        const curValues = fetchQuestionValues(req.user!.tenantId, q.id, effectiveDeptId, windows.curFrom, windows.curTo);
        const prevValues = fetchQuestionValues(req.user!.tenantId, q.id, effectiveDeptId, windows.prevFrom, windows.prevTo);
        const curMetric = primaryMetric(q.answer_type, curValues);
        const prevMetric = primaryMetric(q.answer_type, prevValues);
        const change = curMetric != null && prevMetric != null ? round2(curMetric - prevMetric) : null;
        return {
          id: q.id,
          code: q.code,
          textAr: q.text_ar,
          isCustom: q.is_custom === 1,
          domainNameAr: q.domain_name_ar,
          n: curValues.length,
          currentValue: curMetric,
          previousValue: prevMetric,
          change
        };
      })
      .filter((m) => m.change != null);

    const increases = [...movers].sort((a, b) => (b.change ?? 0) - (a.change ?? 0)).slice(0, 5);
    const declines = [...movers].sort((a, b) => (a.change ?? 0) - (b.change ?? 0)).slice(0, 5);

    res.json({ increases, declines });
  });

  // Report parameters/audit block: the filters, thresholds and facility scope in effect for
  // the current report view, plus a "selected sites" list of departments included — an
  // audit-trail summary matching the parameter header page of external PREMs reports.
  router.get('/reports/parameters', (req: Request, res: Response) => {
    const serviceType = req.query.serviceType as ServiceType | undefined;
    const departmentId = req.query.departmentId as string | undefined;
    const effectiveDeptId = req.user!.role === 'DepartmentManager' ? req.user!.departmentId : departmentId;

    if (req.user!.role === 'DepartmentManager' && departmentId && departmentId !== req.user!.departmentId) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    const tenant = db.prepare('SELECT name_ar, name_en FROM tenants WHERE id = ?').get(req.user!.tenantId) as
      | { name_ar: string; name_en: string }
      | undefined;

    const departmentsIncluded = db
      .prepare(
        `SELECT d.id, d.name_ar as departmentNameAr, d.name_en as departmentNameEn, d.service_type as serviceType,
                f.name_ar as facilityNameAr, f.name_en as facilityNameEn
         FROM departments d JOIN facilities f ON f.id = d.facility_id
         WHERE d.tenant_id = ? AND d.active = 1
         ${serviceType ? 'AND d.service_type = ?' : ''}
         ${effectiveDeptId ? 'AND d.id = ?' : ''}
         ORDER BY d.service_type, d.name_ar`
      )
      .all(...[req.user!.tenantId, ...(serviceType ? [serviceType] : []), ...(effectiveDeptId ? [effectiveDeptId] : [])]);

    res.json({
      tenantNameAr: tenant?.name_ar ?? null,
      tenantNameEn: tenant?.name_en ?? null,
      generatedAt: new Date().toISOString(),
      filters: {
        serviceType: serviceType ?? null,
        departmentId: effectiveDeptId ?? null,
        period: (req.query.period as string | undefined) ?? null,
        from: (req.query.from as string | undefined) ?? null,
        to: (req.query.to as string | undefined) ?? null
      },
      thresholds: {
        smallSampleThreshold: SMALL_SAMPLE_THRESHOLD,
        reliableSampleThreshold: RELIABLE_SAMPLE_THRESHOLD,
        publicReportingSampleThreshold: PUBLIC_REPORTING_SAMPLE_THRESHOLD
      },
      departmentsIncluded
    });
  });

  // External peer-group benchmarks (admin-maintained). There is no live external benchmarking
  // data feed (no subscription to a real peer-group database), so these are manually entered
  // reference values shown alongside our own internal scores for named peer groups such as
  // "All PG Database" or "GCC" — a practical stand-in for the real thing.
  router.get('/reports/benchmarks', requireRole('SystemAdmin', 'QualityManager'), (req: Request, res: Response) => {
    const domainId = req.query.domainId as string | undefined;
    const rows = db
      .prepare(
        `SELECT eb.id, eb.domain_id as domainId, eb.peer_group_name as peerGroupName, eb.value, eb.updated_at as updatedAt,
                d.name_ar as domainNameAr, d.name_en as domainNameEn, d.service_type as serviceType
         FROM external_benchmarks eb JOIN question_domains d ON d.id = eb.domain_id
         WHERE d.tenant_id = ? ${domainId ? 'AND eb.domain_id = ?' : ''}
         ORDER BY d.service_type, d.name_ar, eb.peer_group_name`
      )
      .all(...(domainId ? [req.user!.tenantId, domainId] : [req.user!.tenantId]));
    res.json({ benchmarks: rows });
  });

  router.post('/reports/benchmarks', requireRole('SystemAdmin', 'QualityManager'), express.json({ limit: '4kb' }), (req: Request, res: Response) => {
    const { domainId, peerGroupName, value } = req.body as { domainId?: string; peerGroupName?: string; value?: number };
    if (!domainId || !peerGroupName || typeof value !== 'number') {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const domain = db.prepare('SELECT id FROM question_domains WHERE id = ? AND tenant_id = ?').get(domainId, req.user!.tenantId);
    if (!domain) {
      res.status(404).json({ error: 'domain_not_found' });
      return;
    }
    const existing = db
      .prepare('SELECT id FROM external_benchmarks WHERE domain_id = ? AND peer_group_name = ?')
      .get(domainId, peerGroupName) as { id: string } | undefined;
    if (existing) {
      db.prepare("UPDATE external_benchmarks SET value = ?, updated_at = datetime('now') WHERE id = ?").run(value, existing.id);
      logAudit(db, req.user!.tenantId, req.user!.id, 'benchmark_updated', 'external_benchmark', existing.id, { domainId, peerGroupName, value });
      res.json({ id: existing.id });
      return;
    }
    const id = uid();
    db.prepare('INSERT INTO external_benchmarks (id, tenant_id, domain_id, peer_group_name, value) VALUES (?, ?, ?, ?, ?)').run(
      id,
      req.user!.tenantId,
      domainId,
      peerGroupName,
      value
    );
    logAudit(db, req.user!.tenantId, req.user!.id, 'benchmark_created', 'external_benchmark', id, { domainId, peerGroupName, value });
    res.status(201).json({ id });
  });

  router.delete('/reports/benchmarks/:id', requireRole('SystemAdmin', 'QualityManager'), (req: Request, res: Response) => {
    const existing = db
      .prepare('SELECT eb.id FROM external_benchmarks eb JOIN question_domains d ON d.id = eb.domain_id WHERE eb.id = ? AND d.tenant_id = ?')
      .get(req.params.id, req.user!.tenantId);
    if (!existing) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    db.prepare('DELETE FROM external_benchmarks WHERE id = ?').run(req.params.id);
    logAudit(db, req.user!.tenantId, req.user!.id, 'benchmark_deleted', 'external_benchmark', req.params.id, {});
    res.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Comments Intelligence + Service Recovery
  // -------------------------------------------------------------------------
  router.get('/comments', (req: Request, res: Response) => {
    const { clause, params } = departmentScopeFilter(req, 'c');
    const category = req.query.category as string | undefined;
    const severityMin = req.query.severityMin ? Number(req.query.severityMin) : undefined;
    const unacknowledgedOnly = req.query.unacknowledgedOnly === 'true';
    const serviceType = req.query.serviceType as string | undefined;
    const providerName = req.query.providerName as string | undefined;

    const rows = db
      .prepare(
        `SELECT c.id, c.department_id, c.redacted_text, c.created_at,
                ca.sentiment, ca.category, ca.severity,
                src.id as case_id, src.status as case_status, src.assigned_to, src.resolution_notes,
                al.id as alert_id, al.acknowledged as alert_acknowledged,
                d.name_ar as department_name_ar, d.service_type, si.provider_name
         FROM comments c
         JOIN comment_analyses ca ON ca.comment_id = c.id
         JOIN departments d ON d.id = c.department_id
         JOIN survey_responses sr ON sr.id = c.response_id
         JOIN survey_invitations si ON si.id = sr.invitation_id
         LEFT JOIN service_recovery_cases src ON src.comment_id = c.id
         LEFT JOIN comment_alerts al ON al.comment_id = c.id
         WHERE c.tenant_id = ? ${clause}
         ${category ? 'AND ca.category = ?' : ''}
         ${severityMin !== undefined ? 'AND ca.severity >= ?' : ''}
         ${unacknowledgedOnly ? "AND al.id IS NOT NULL AND al.acknowledged = 0" : ''}
         ${serviceType ? 'AND d.service_type = ?' : ''}
         ${providerName ? 'AND si.provider_name LIKE ?' : ''}
         ORDER BY c.created_at DESC
         LIMIT 200`
      )
      .all(
        ...[
          req.user!.tenantId,
          ...params,
          ...(category ? [category] : []),
          ...(severityMin !== undefined ? [severityMin] : []),
          ...(serviceType ? [serviceType] : []),
          ...(providerName ? [`%${providerName}%`] : [])
        ]
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
      if (existingCase) existingCase.patient_contact_phone = decryptPii(existingCase.patient_contact_phone);

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
                src.patient_contact_opt_in, src.patient_notified_at, src.escalation_level, src.improvement_plan_id,
                u.full_name as assigned_to_name,
                c.redacted_text, ca.severity, ca.category,
                qip.title as improvement_plan_title, qip.status as improvement_plan_status
         FROM service_recovery_cases src
         JOIN comments c ON c.id = src.comment_id
         JOIN comment_analyses ca ON ca.comment_id = c.id
         LEFT JOIN users u ON u.id = src.assigned_to
         LEFT JOIN quality_improvement_plans qip ON qip.id = src.improvement_plan_id
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
  // Quality improvement plans (RFP SRC-06) — corrective/preventive actions that a service
  // recovery case can be linked to, so a recurring root cause gets fixed once, not re-litigated
  // case by case, with a place to record whether the fix actually worked.
  // -------------------------------------------------------------------------
  router.get(
    '/service-recovery/improvement-plans',
    requireRole('SystemAdmin', 'QualityManager', 'DepartmentManager'),
    (req: Request, res: Response) => {
      const { clause, params } = departmentScopeFilter(req, 'qip');
      const rows = db
        .prepare(
          `SELECT qip.id, qip.title, qip.corrective_action, qip.status, qip.due_date, qip.effectiveness_notes, qip.created_at,
                  qip.department_id, d.name_ar as department_name_ar, u.full_name as owner_name
           FROM quality_improvement_plans qip
           LEFT JOIN departments d ON d.id = qip.department_id
           LEFT JOIN users u ON u.id = qip.owner_user_id
           WHERE qip.tenant_id = ? ${clause}
           ORDER BY qip.created_at DESC`
        )
        .all(req.user!.tenantId, ...params);
      res.json({ plans: rows });
    }
  );

  router.post(
    '/service-recovery/improvement-plans',
    requireRole('SystemAdmin', 'QualityManager', 'DepartmentManager'),
    express.json({ limit: '8kb' }),
    (req: Request, res: Response) => {
      const { title, correctiveAction, departmentId, ownerUserId, dueDate } = req.body as {
        title?: string;
        correctiveAction?: string;
        departmentId?: string;
        ownerUserId?: string;
        dueDate?: string;
      };
      if (!title) {
        res.status(400).json({ error: 'title_required' });
        return;
      }
      if (req.user!.role === 'DepartmentManager' && departmentId && departmentId !== req.user!.departmentId) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      const effectiveDeptId = req.user!.role === 'DepartmentManager' ? req.user!.departmentId : (departmentId ?? null);
      const id = uid();
      db.prepare(
        'INSERT INTO quality_improvement_plans (id, tenant_id, department_id, title, corrective_action, owner_user_id, due_date) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(id, req.user!.tenantId, effectiveDeptId, title, correctiveAction ?? null, ownerUserId ?? null, dueDate ?? null);
      logAudit(db, req.user!.tenantId, req.user!.id, 'improvement_plan_created', 'quality_improvement_plan', id, { title });
      res.status(201).json({ id });
    }
  );

  router.patch(
    '/service-recovery/improvement-plans/:id',
    requireRole('SystemAdmin', 'QualityManager', 'DepartmentManager'),
    express.json({ limit: '8kb' }),
    (req: Request, res: Response) => {
      const existing = db
        .prepare('SELECT id, tenant_id, department_id FROM quality_improvement_plans WHERE id = ?')
        .get(req.params.id) as { id: string; tenant_id: string; department_id: string | null } | undefined;
      if (!existing || existing.tenant_id !== req.user!.tenantId) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (req.user!.role === 'DepartmentManager' && existing.department_id !== req.user!.departmentId) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      const { status, effectivenessNotes } = req.body as { status?: string; effectivenessNotes?: string };
      if (status !== undefined) db.prepare('UPDATE quality_improvement_plans SET status = ? WHERE id = ?').run(status, existing.id);
      if (effectivenessNotes !== undefined)
        db.prepare('UPDATE quality_improvement_plans SET effectiveness_notes = ? WHERE id = ?').run(effectivenessNotes, existing.id);
      logAudit(db, req.user!.tenantId, req.user!.id, 'improvement_plan_updated', 'quality_improvement_plan', existing.id, { status });
      res.json({ ok: true });
    }
  );

  router.patch(
    '/service-recovery/cases/:id/link-plan',
    requireRole('SystemAdmin', 'QualityManager', 'DepartmentManager'),
    express.json({ limit: '4kb' }),
    (req: Request, res: Response) => {
      const existingCase = db.prepare('SELECT id, tenant_id, department_id FROM service_recovery_cases WHERE id = ?').get(req.params.id) as
        | { id: string; tenant_id: string; department_id: string }
        | undefined;
      if (!existingCase || existingCase.tenant_id !== req.user!.tenantId) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (req.user!.role === 'DepartmentManager' && existingCase.department_id !== req.user!.departmentId) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      const { improvementPlanId } = req.body as { improvementPlanId: string | null };
      if (improvementPlanId) {
        const plan = db
          .prepare('SELECT id FROM quality_improvement_plans WHERE id = ? AND tenant_id = ?')
          .get(improvementPlanId, req.user!.tenantId);
        if (!plan) {
          res.status(400).json({ error: 'invalid_plan' });
          return;
        }
      }
      db.prepare('UPDATE service_recovery_cases SET improvement_plan_id = ? WHERE id = ?').run(improvementPlanId ?? null, existingCase.id);
      logAudit(db, req.user!.tenantId, req.user!.id, 'case_linked_to_improvement_plan', 'service_recovery_case', existingCase.id, { improvementPlanId });
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
      const { rows, templateId, departmentId, channel, providerName } = req.body as {
        rows?: { phone?: string; email?: string; ageBand?: AgeBand }[];
        templateId?: string;
        departmentId?: string;
        channel?: 'sms' | 'whatsapp' | 'phone' | 'email';
        providerName?: string;
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
      const emailProvider = createEmailProvider();
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const effectiveChannel = channel ?? 'sms';

      const insert = db.prepare(
        `INSERT INTO survey_invitations
         (id, tenant_id, template_id, department_id, service_type, token_hash, patient_phone_hash, channel, status, expires_at, sent_at, provider_name, patient_age_band)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const now = new Date().toISOString();
      const expires = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
      let created = 0;
      let sent = 0;
      let skipped = 0;
      for (const row of rows) {
        // For an email-channel batch, patient_phone_hash holds a hash of the email address
        // instead of a phone number — same DNC/cooldown eligibility semantics, just a different
        // contact identifier, so no schema change is needed for this new channel.
        const contact = effectiveChannel === 'email' ? row.email : row.phone;
        if (!contact) continue;
        const contactHash = sha256(contact);
        if (!isEligibleForInvitation(db, req.user!.tenantId, contactHash).eligible) {
          skipped += 1;
          continue;
        }
        if (row.ageBand !== undefined && !AGE_BANDS.includes(row.ageBand)) continue;
        const rawToken = uid();
        let status = 'pending';
        if (effectiveChannel === 'sms' || effectiveChannel === 'whatsapp') {
          const surveyUrl = `${baseUrl}/s/${rawToken}`;
          const message = composeInvitationMessage(template.name_ar, template.name_en, surveyUrl, smsConfig.defaultLanguage);
          const result = await provider.send(contact, message);
          status = result.ok ? 'sent' : 'pending';
          if (result.ok) sent += 1;
        } else if (effectiveChannel === 'email') {
          const surveyUrl = `${baseUrl}/s/${rawToken}`;
          const { subject, body } = composeInvitationEmail(template.name_ar, template.name_en, surveyUrl, smsConfig.defaultLanguage);
          const result = await emailProvider.send(contact, subject, body);
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
          contactHash,
          effectiveChannel,
          status,
          expires,
          now,
          providerName?.trim() || null,
          row.ageBand ?? null
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
        providerName?: string;
        ageBand?: AgeBand;
      };
      if (!body.templateId || !body.departmentId || !body.patientPhone || !Array.isArray(body.answers)) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      if (body.ageBand !== undefined && !AGE_BANDS.includes(body.ageBand)) {
        res.status(400).json({ error: 'invalid_age_band' });
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
         (id, tenant_id, template_id, department_id, service_type, token_hash, patient_phone_hash, channel, status, expires_at, sent_at, created_at, provider_name, patient_age_band)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'phone', 'completed', ?, ?, ?, ?, ?)`
      ).run(
        invitationId,
        req.user!.tenantId,
        template.id,
        body.departmentId,
        template.service_type,
        sha256(uid()),
        sha256(body.patientPhone),
        now,
        now,
        now,
        body.providerName?.trim() || null,
        body.ageBand ?? null
      );

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
          ).run(uid(), commentId, req.user!.tenantId, body.departmentId, now, optIn ? 1 : 0, optIn ? encryptPii(body.patientPhone!) : null);
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
      contactPhone ? encryptPii(contactPhone) : null,
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
      // contact_phone is stored encrypted and is never sent to the client — only whether one is
      // on file, which is all the due-assignments panel needs to decide what action to offer.
      const rows = db
        .prepare(
          `SELECT pa.id, pa.due_date, pa.status, pe.id as episode_id,
                  CASE WHEN pe.contact_phone IS NOT NULL THEN 1 ELSE 0 END as has_contact_phone, pe.surgeon_ref,
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
      assignment.contact_phone = decryptPii(assignment.contact_phone);
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
  // -------------------------------------------------------------------------
  // Branding (RFP UX-05) — logo and accent color shown on the patient/employee-facing survey
  // pages. Read here for the admin editor; the public survey endpoints call getTenantBranding
  // directly so an anonymous respondent never needs to authenticate to see it.
  // -------------------------------------------------------------------------
  const MAX_LOGO_DATA_URI_LENGTH = 300_000; // ~220KB decoded, generous for a small logo image
  const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

  router.get('/settings/branding', requireRole('SystemAdmin'), (req: Request, res: Response) => {
    res.json(getTenantBranding(db, req.user!.tenantId));
  });

  router.patch(
    '/settings/branding',
    requireRole('SystemAdmin'),
    express.json({ limit: '400kb' }),
    (req: Request, res: Response) => {
      const { logoDataUri, primaryColor } = req.body as { logoDataUri?: string | null; primaryColor?: string };
      if (logoDataUri !== undefined) {
        if (logoDataUri !== null && (!logoDataUri.startsWith('data:image/') || logoDataUri.length > MAX_LOGO_DATA_URI_LENGTH)) {
          res.status(400).json({ error: 'invalid_logo' });
          return;
        }
        db.prepare('UPDATE tenants SET logo_data_uri = ? WHERE id = ?').run(logoDataUri, req.user!.tenantId);
      }
      if (primaryColor !== undefined) {
        if (!HEX_COLOR_RE.test(primaryColor)) {
          res.status(400).json({ error: 'invalid_color' });
          return;
        }
        db.prepare('UPDATE tenants SET brand_primary_color = ? WHERE id = ?').run(primaryColor, req.user!.tenantId);
      }
      logAudit(db, req.user!.tenantId, req.user!.id, 'branding_updated', 'tenant', req.user!.tenantId, {
        logoChanged: logoDataUri !== undefined,
        primaryColor
      });
      res.json(getTenantBranding(db, req.user!.tenantId));
    }
  );

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

  // -------------------------------------------------------------------------
  // Backups (RFP INF-05) — visibility into the automated daily backup scheduled in server.ts,
  // plus an on-demand trigger for right before a risky change.
  // -------------------------------------------------------------------------
  router.get('/settings/backups', requireRole('SystemAdmin'), (_req: Request, res: Response) => {
    const backupDir = defaultBackupDir(root);
    const backups = listBackups(backupDir);
    res.json({
      backups,
      lastBackupAt: backups[0]?.createdAt ?? null,
      retentionDays: Number(process.env.BACKUP_RETENTION_DAYS ?? 14),
      rpoTargetHours: 4,
      rtoTargetHours: 8
    });
  });

  router.post('/settings/backups/run', requireRole('SystemAdmin'), (req: Request, res: Response) => {
    const backupDir = defaultBackupDir(root);
    const result = runBackup(db, backupDir);
    if (!result.ok) {
      res.status(500).json({ error: 'backup_failed', detail: result.error });
      return;
    }
    logAudit(db, req.user!.tenantId, req.user!.id, 'backup_run_manually', 'backup', null, { fileName: result.fileName });
    res.status(201).json(result);
  });

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
  // Employee Experience & Engagement (RFP OPT-03) — parallel to the PREMs module above, but
  // access is restricted to SystemAdmin/QualityManager since roster contact info and even
  // small-group scores are HR-sensitive, not general operational reporting.
  // -------------------------------------------------------------------------
  router.get('/employee-experience/instruments', requireRole('SystemAdmin', 'QualityManager', 'ExecutiveViewer'), (req: Request, res: Response) => {
    const rows = db
      .prepare('SELECT id, code, name_ar, name_en, kind, active FROM employee_survey_instruments WHERE tenant_id = ? ORDER BY kind, name_ar')
      .all(req.user!.tenantId);
    res.json({ instruments: rows });
  });

  router.get(
    '/employee-experience/instruments/:id/structure',
    requireRole('SystemAdmin', 'QualityManager'),
    (req: Request, res: Response) => {
      const instrument = db
        .prepare('SELECT id, name_ar, name_en FROM employee_survey_instruments WHERE id = ? AND tenant_id = ?')
        .get(req.params.id, req.user!.tenantId) as { id: string; name_ar: string; name_en: string } | undefined;
      if (!instrument) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const domains = db
        .prepare('SELECT id, code, name_ar, name_en, is_driver, active FROM employee_survey_domains WHERE instrument_id = ?')
        .all(instrument.id) as { id: string; code: string; name_ar: string; name_en: string; is_driver: number; active: number }[];
      const questions = db
        .prepare(
          `SELECT id, domain_id, text_ar, text_en, answer_type, is_overall, active, sort_order FROM employee_survey_questions
           WHERE domain_id IN (SELECT id FROM employee_survey_domains WHERE instrument_id = ?) ORDER BY sort_order`
        )
        .all(instrument.id) as {
        id: string;
        domain_id: string;
        text_ar: string;
        text_en: string;
        answer_type: string;
        is_overall: number;
        active: number;
        sort_order: number;
      }[];
      res.json({
        instrument,
        domains: domains.map((d) => ({ ...d, questions: questions.filter((q) => q.domain_id === d.id) }))
      });
    }
  );

  // Minimal roster used only to target invitation cohorts — never joined to a submitted
  // response. Contact info is encrypted at rest (server/crypto.ts) and never returned in full.
  router.get('/employee-experience/employees', requireRole('SystemAdmin', 'QualityManager'), (req: Request, res: Response) => {
    const rows = db
      .prepare(
        `SELECT e.id, e.job_category, e.contact_channel, e.active, e.department_id, d.name_ar as department_name_ar
         FROM employees e LEFT JOIN departments d ON d.id = e.department_id
         WHERE e.tenant_id = ? ORDER BY e.created_at DESC`
      )
      .all(req.user!.tenantId);
    res.json({ employees: rows });
  });

  router.post('/employee-experience/employees', requireRole('SystemAdmin'), express.json({ limit: '8kb' }), (req: Request, res: Response) => {
    const body = req.body as { departmentId?: string; jobCategory?: string; contactChannel?: 'email' | 'sms'; contactValue?: string };
    if (!body.jobCategory || !body.contactValue || !body.contactChannel) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const id = uid();
    db.prepare(
      'INSERT INTO employees (id, tenant_id, department_id, job_category, contact_channel, contact_value_encrypted) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, req.user!.tenantId, body.departmentId ?? null, body.jobCategory, body.contactChannel, encryptPii(body.contactValue));
    logAudit(db, req.user!.tenantId, req.user!.id, 'employee_added', 'employees', id, { jobCategory: body.jobCategory });
    res.status(201).json({ id });
  });

  router.delete('/employee-experience/employees/:id', requireRole('SystemAdmin'), (req: Request, res: Response) => {
    db.prepare('UPDATE employees SET active = 0 WHERE id = ? AND tenant_id = ?').run(req.params.id, req.user!.tenantId);
    logAudit(db, req.user!.tenantId, req.user!.id, 'employee_deactivated', 'employees', req.params.id, null);
    res.json({ ok: true });
  });

  // Bulk-invites every active employee matching the given cohort filters. Anonymous by design:
  // the invitation snapshots department/job-category for later reporting, but the response
  // itself (see /public/employee-survey/:token/submit) never carries the employee's identity.
  router.post(
    '/employee-experience/invitations',
    requireRole('SystemAdmin', 'QualityManager'),
    express.json({ limit: '8kb' }),
    async (req: Request, res: Response) => {
      const body = req.body as { instrumentId?: string; departmentId?: string; jobCategory?: string };
      if (!body.instrumentId) {
        res.status(400).json({ error: 'instrument_id_required' });
        return;
      }
      const instrument = db
        .prepare('SELECT id, name_ar, name_en FROM employee_survey_instruments WHERE id = ? AND tenant_id = ?')
        .get(body.instrumentId, req.user!.tenantId) as { id: string; name_ar: string; name_en: string } | undefined;
      if (!instrument) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      let sql = 'SELECT id, department_id, job_category, contact_channel, contact_value_encrypted FROM employees WHERE tenant_id = ? AND active = 1';
      const params: string[] = [req.user!.tenantId];
      if (body.departmentId) {
        sql += ' AND department_id = ?';
        params.push(body.departmentId);
      }
      if (body.jobCategory) {
        sql += ' AND job_category = ?';
        params.push(body.jobCategory);
      }
      const employees = db.prepare(sql).all(...params) as {
        id: string;
        department_id: string | null;
        job_category: string;
        contact_channel: string;
        contact_value_encrypted: string | null;
      }[];

      const smsConfig = getTenantSmsConfig(db, req.user!.tenantId);
      const smsProvider = createSmsProvider(smsConfig);
      const emailProvider = createEmailProvider();
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const expiresAt = new Date(Date.now() + EMPLOYEE_SURVEY_LINK_VALID_DAYS * 24 * 60 * 60 * 1000).toISOString();

      let sent = 0;
      for (const employee of employees) {
        const contactValue = decryptPii(employee.contact_value_encrypted);
        if (!contactValue) continue;
        const rawToken = uid().replace(/-/g, '');
        const invitationId = uid();
        db.prepare(
          `INSERT INTO employee_survey_invitations
           (id, tenant_id, instrument_id, employee_id, department_id, job_category, token_hash, status, sent_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'sent', datetime('now'), ?)`
        ).run(invitationId, req.user!.tenantId, instrument.id, employee.id, employee.department_id, employee.job_category, sha256(rawToken), expiresAt);

        const surveyUrl = `${baseUrl}/e/${rawToken}`;
        if (employee.contact_channel === 'sms') {
          const message = composeEmployeeSurveyMessage(instrument.name_ar, instrument.name_en, surveyUrl, smsConfig.defaultLanguage);
          await smsProvider.send(contactValue, message);
        } else {
          const { subject, body: emailBody } = composeEmployeeSurveyEmail(instrument.name_ar, instrument.name_en, surveyUrl, smsConfig.defaultLanguage);
          await emailProvider.send(contactValue, subject, emailBody);
        }
        sent += 1;
      }
      logAudit(db, req.user!.tenantId, req.user!.id, 'employee_survey_invitations_sent', 'employee_survey_invitations', null, {
        instrumentId: instrument.id,
        sent
      });
      res.status(201).json({ sent });
    }
  );

  // Aggregate scores with a hard confidentiality floor: any department whose respondent count
  // falls below MIN_GROUP_SIZE_FOR_REPORTING is returned as suppressed rather than with figures,
  // per OPT-03E ("لا يسمح بعرض نتائج الفئات الصغيرة").
  router.get(
    '/employee-experience/dashboard',
    requireRole('SystemAdmin', 'QualityManager', 'ExecutiveViewer', 'DepartmentManager'),
    (req: Request, res: Response) => {
      const instrumentId = req.query.instrumentId as string | undefined;
      if (!instrumentId) {
        res.status(400).json({ error: 'instrument_id_required' });
        return;
      }
      const effectiveDeptId = req.user!.role === 'DepartmentManager' ? req.user!.departmentId : (req.query.departmentId as string | undefined);

      const answerRows = db
        .prepare(
          `SELECT esr.department_id, esd.id as domain_id, esd.name_ar as domain_name_ar, esd.name_en as domain_name_en,
                  esd.is_driver, esq.is_overall, esq.answer_type, esa.value_numeric as value
           FROM employee_survey_answers esa
           JOIN employee_survey_questions esq ON esq.id = esa.question_id
           JOIN employee_survey_domains esd ON esd.id = esq.domain_id
           JOIN employee_survey_responses esr ON esr.id = esa.response_id
           WHERE esr.tenant_id = ? AND esr.instrument_id = ? AND esq.answer_type != 'text'
                 ${effectiveDeptId ? 'AND esr.department_id = ?' : ''}`
        )
        .all(...[req.user!.tenantId, instrumentId, ...(effectiveDeptId ? [effectiveDeptId] : [])]) as {
        department_id: string | null;
        domain_id: string;
        domain_name_ar: string;
        domain_name_en: string;
        is_driver: number;
        is_overall: number;
        answer_type: string;
        value: number;
      }[];

      const respondentCount = db
        .prepare(
          `SELECT COUNT(*) as n FROM employee_survey_responses WHERE tenant_id = ? AND instrument_id = ? ${effectiveDeptId ? 'AND department_id = ?' : ''}`
        )
        .get(...[req.user!.tenantId, instrumentId, ...(effectiveDeptId ? [effectiveDeptId] : [])]) as { n: number };

      if (respondentCount.n < MIN_GROUP_SIZE_FOR_REPORTING) {
        res.json({
          n: respondentCount.n,
          suppressed: true,
          minGroupSize: MIN_GROUP_SIZE_FOR_REPORTING,
          participationRate: null,
          enps: null,
          avgRecommendation: null,
          domains: []
        });
        return;
      }

      // The eNPS (0-10) domain uses a different metric (% scoring 9-10, per MOH KPI 5.1.1) than
      // every likert domain (% scoring 4-5) — pooling the two scales together would corrupt both,
      // so it is computed and reported separately rather than appearing in `domains`.
      const npsRows = answerRows.filter((r) => r.answer_type === 'nps');
      const likertRows = answerRows.filter((r) => r.answer_type !== 'nps');
      const promoterScore = scorePromoterPercent(npsRows.map((r) => r.value));

      // "Participation rate" mirrors the hospital's own "معدل المشاركة" methodology: the % of
      // answers rating 4-5 across every driver (non-outcome) likert domain.
      const driverValues = likertRows.filter((r) => r.is_driver === 1).map((r) => r.value);
      const participationRate = scoreAgreePercent(driverValues).agreePercent;

      const domainIds = [...new Set(likertRows.map((r) => r.domain_id))];
      const domains = domainIds.map((domainId) => {
        const rowsForDomain = likertRows.filter((r) => r.domain_id === domainId);
        const score = scoreAgreePercent(rowsForDomain.map((r) => r.value));
        return {
          domainId,
          nameAr: rowsForDomain[0].domain_name_ar,
          nameEn: rowsForDomain[0].domain_name_en,
          isDriver: rowsForDomain[0].is_driver === 1,
          ...score
        };
      });

      // Department breakdown, each group individually suppressed if below the confidentiality floor.
      const departmentBreakdown = !effectiveDeptId
        ? (
            db
              .prepare(
                `SELECT esr.department_id, d.name_ar as department_name_ar, COUNT(*) as n
                 FROM employee_survey_responses esr LEFT JOIN departments d ON d.id = esr.department_id
                 WHERE esr.tenant_id = ? AND esr.instrument_id = ? GROUP BY esr.department_id`
              )
              .all(req.user!.tenantId, instrumentId) as { department_id: string | null; department_name_ar: string | null; n: number }[]
          ).map((row) => ({
            departmentId: row.department_id,
            departmentNameAr: row.department_name_ar,
            n: row.n,
            suppressed: row.n < MIN_GROUP_SIZE_FOR_REPORTING
          }))
        : [];

      res.json({
        n: respondentCount.n,
        suppressed: false,
        participationRate,
        enps: promoterScore.promoterPercent,
        avgRecommendation: promoterScore.mean,
        domains,
        departmentBreakdown
      });
    }
  );

  // Driver analysis: correlates each domain's per-respondent mean with the same respondent's
  // overall-engagement item — same "high-importance" logic as /reports/priority-index on the
  // PREMs side, applied to the employee instrument's is_driver domains.
  router.get(
    '/employee-experience/driver-analysis',
    requireRole('SystemAdmin', 'QualityManager', 'ExecutiveViewer'),
    (req: Request, res: Response) => {
      const instrumentId = req.query.instrumentId as string | undefined;
      if (!instrumentId) {
        res.status(400).json({ error: 'instrument_id_required' });
        return;
      }
      const overallByResponse = db
        .prepare(
          `SELECT esr.id as response_id, AVG(esa.value_numeric) as overall_value
           FROM employee_survey_responses esr
           JOIN employee_survey_answers esa ON esa.response_id = esr.id
           JOIN employee_survey_questions esq ON esq.id = esa.question_id
           WHERE esr.tenant_id = ? AND esr.instrument_id = ? AND esq.is_overall = 1
           GROUP BY esr.id`
        )
        .all(req.user!.tenantId, instrumentId) as { response_id: string; overall_value: number }[];
      const overallMap = new Map(overallByResponse.map((r) => [r.response_id, r.overall_value]));

      const driverDomains = db
        .prepare('SELECT id, name_ar, name_en FROM employee_survey_domains WHERE instrument_id = ? AND is_driver = 1')
        .all(instrumentId) as { id: string; name_ar: string; name_en: string }[];

      const domainMeansByResponse = db
        .prepare(
          `SELECT esr.id as response_id, esd.id as domain_id, AVG(esa.value_numeric) as domain_mean
           FROM employee_survey_responses esr
           JOIN employee_survey_answers esa ON esa.response_id = esr.id
           JOIN employee_survey_questions esq ON esq.id = esa.question_id
           JOIN employee_survey_domains esd ON esd.id = esq.domain_id
           WHERE esr.tenant_id = ? AND esr.instrument_id = ? AND esd.is_driver = 1
           GROUP BY esr.id, esd.id`
        )
        .all(req.user!.tenantId, instrumentId) as { response_id: string; domain_id: string; domain_mean: number }[];

      const items = driverDomains
        .map((domain) => {
          const pairs: [number, number][] = domainMeansByResponse
            .filter((row) => row.domain_id === domain.id)
            .map((row) => [row.domain_mean, overallMap.get(row.response_id)])
            .filter((pair): pair is [number, number] => pair[1] !== undefined);
          return { domainId: domain.id, nameAr: domain.name_ar, nameEn: domain.name_en, n: pairs.length, correlation: pearsonCorrelation(pairs) };
        })
        .filter((item) => item.n >= MIN_GROUP_SIZE_FOR_REPORTING)
        .sort((a, b) => (b.correlation ?? 0) - (a.correlation ?? 0));

      res.json({ items });
    }
  );

  // -------------------------------------------------------------------------
  // Employee improvement plans (OPT-03D) — links a driver domain's weak result to a tracked
  // corrective action, mirroring how service_recovery_cases track PREMs-side follow-up.
  // -------------------------------------------------------------------------
  router.get('/employee-experience/improvement-plans', requireRole('SystemAdmin', 'QualityManager', 'DepartmentManager'), (req: Request, res: Response) => {
    const effectiveDeptId = req.user!.role === 'DepartmentManager' ? req.user!.departmentId : undefined;
    const rows = db
      .prepare(
        `SELECT p.id, p.title, p.status, p.due_date, p.created_at, p.department_id, d.name_ar as department_name_ar,
                p.domain_id, u.full_name as owner_name
         FROM employee_improvement_plans p
         LEFT JOIN departments d ON d.id = p.department_id
         LEFT JOIN users u ON u.id = p.owner_user_id
         WHERE p.tenant_id = ? ${effectiveDeptId ? 'AND p.department_id = ?' : ''}
         ORDER BY p.created_at DESC`
      )
      .all(...[req.user!.tenantId, ...(effectiveDeptId ? [effectiveDeptId] : [])]);
    res.json({ plans: rows });
  });

  router.post(
    '/employee-experience/improvement-plans',
    requireRole('SystemAdmin', 'QualityManager'),
    express.json({ limit: '8kb' }),
    (req: Request, res: Response) => {
      const body = req.body as { title?: string; departmentId?: string; domainId?: string; ownerUserId?: string; dueDate?: string };
      if (!body.title) {
        res.status(400).json({ error: 'title_required' });
        return;
      }
      const id = uid();
      db.prepare(
        'INSERT INTO employee_improvement_plans (id, tenant_id, department_id, domain_id, title, owner_user_id, due_date) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(id, req.user!.tenantId, body.departmentId ?? null, body.domainId ?? null, body.title, body.ownerUserId ?? null, body.dueDate ?? null);
      logAudit(db, req.user!.tenantId, req.user!.id, 'employee_improvement_plan_created', 'employee_improvement_plans', id, { title: body.title });
      res.status(201).json({ id });
    }
  );

  router.patch(
    '/employee-experience/improvement-plans/:id',
    requireRole('SystemAdmin', 'QualityManager'),
    express.json({ limit: '4kb' }),
    (req: Request, res: Response) => {
      const body = req.body as { status?: string };
      if (!body.status) {
        res.status(400).json({ error: 'status_required' });
        return;
      }
      db.prepare('UPDATE employee_improvement_plans SET status = ? WHERE id = ? AND tenant_id = ?').run(body.status, req.params.id, req.user!.tenantId);
      logAudit(db, req.user!.tenantId, req.user!.id, 'employee_improvement_plan_updated', 'employee_improvement_plans', req.params.id, { status: body.status });
      res.json({ ok: true });
    }
  );

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
