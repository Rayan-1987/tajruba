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
  SMALL_SAMPLE_THRESHOLD,
  scoreDomain,
  scoreInstrument,
  scoreNps,
  scoreQuestion,
  scoreYesNo,
  type InstrumentItemValue
} from './scoring.ts';
import { DEFAULT_DEPARTMENTS, provisionTenantDefaults } from './provisioning.ts';
import { composeInvitationMessage, createSmsProvider, type TenantSmsConfig } from './sms.ts';
import type { AnswerType, RecoveryStatus, Role, ServiceType } from './types.ts';

function uid(): string {
  return randomUUID();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
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

    const body = req.body as { answers?: { questionId: string; value: number }[]; comment?: string; language?: string };
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
        db.prepare(
          `INSERT INTO service_recovery_cases (id, comment_id, tenant_id, department_id, status, opened_at)
           VALUES (?, ?, ?, ?, 'new', ?)`
        ).run(uid(), commentId, invitation.tenant_id, invitation.department_id, submittedAt);
      }
    }

    db.prepare("UPDATE survey_invitations SET status = 'completed' WHERE id = ?").run(invitation.id);
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
    for (const row of rows) {
      if (!row.phone) continue;
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
        sha256(row.phone),
        effectiveChannel,
        result.ok ? 'sent' : 'pending',
        expires,
        now
      );
      created += 1;
    }
    logAudit(db, tenantId, null, 'invitations_webhook_created', 'survey_invitation', null, { count: created, sent });
    res.status(201).json({ created, sent });
  });

  // Everything below requires an authenticated session.
  router.use(requireAuth);

  // -------------------------------------------------------------------------
  // Departments / question bank / templates (read-mostly reference data)
  // -------------------------------------------------------------------------
  router.get('/departments', (req: Request, res: Response) => {
    const rows = db
      .prepare('SELECT id, name_ar, name_en, service_type FROM departments WHERE tenant_id = ? AND active = 1 ORDER BY service_type')
      .all(req.user!.tenantId);
    res.json({ departments: rows });
  });

  router.get('/question-bank', (req: Request, res: Response) => {
    const domains = db
      .prepare('SELECT id, code, name_ar, name_en, service_type, benchmark_mean FROM question_domains WHERE tenant_id = ? AND active = 1')
      .all(req.user!.tenantId);
    const questions = db
      .prepare(
        'SELECT id, code, domain_id, text_ar, text_en, answer_type, service_type, requires_alert FROM questions WHERE tenant_id = ? AND active = 1 ORDER BY sort_order'
      )
      .all(req.user!.tenantId);
    res.json({ domains, questions });
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
           WHERE tq.template_id = ? ORDER BY tq.sort_order`
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
        `SELECT id, code, name_ar, name_en, service_type, benchmark_mean FROM question_domains
         WHERE tenant_id = ? AND active = 1 AND (? IS NULL OR service_type = ?)`
      )
      .all(req.user!.tenantId, serviceType ?? null, serviceType ?? null) as {
      id: string;
      code: string;
      name_ar: string;
      name_en: string;
      service_type: string;
      benchmark_mean: number;
    }[];

    const results = domains.map((domain) => {
      const questions = db
        .prepare('SELECT id, code, text_ar, text_en, answer_type FROM questions WHERE domain_id = ? ORDER BY sort_order')
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

      const domainScore = scoreDomain(domain.id, allDomainValues, domain.benchmark_mean);
      return {
        domain: { id: domain.id, code: domain.code, nameAr: domain.name_ar, nameEn: domain.name_en, serviceType: domain.service_type },
        score: domainScore,
        questions: questionScores
      };
    });

    res.json({ smallSampleThreshold: SMALL_SAMPLE_THRESHOLD, domains: results });
  });

  router.get('/reports/trend', (req: Request, res: Response) => {
    const serviceType = req.query.serviceType as ServiceType | undefined;
    const departmentId = req.user!.role === 'DepartmentManager' ? req.user!.departmentId : (req.query.departmentId as string | undefined);

    const rows = db
      .prepare(
        `SELECT strftime('%Y-%m', r.submitted_at) as month, AVG(a.value_numeric) as mean, COUNT(*) as n
         FROM answers a
         JOIN survey_responses r ON r.id = a.response_id
         JOIN questions q ON q.id = a.question_id
         JOIN survey_invitations si ON si.id = r.invitation_id
         WHERE r.tenant_id = ? AND q.answer_type = 'likert5'
         ${serviceType ? 'AND q.service_type = ?' : ''}
         ${departmentId ? 'AND si.department_id = ?' : ''}
         GROUP BY month ORDER BY month`
      )
      .all(
        ...[req.user!.tenantId, ...(serviceType ? [serviceType] : []), ...(departmentId ? [departmentId] : [])]
      ) as { month: string; mean: number; n: number }[];

    res.json({ trend: rows });
  });

  // -------------------------------------------------------------------------
  // Comments Intelligence + Service Recovery
  // -------------------------------------------------------------------------
  router.get('/comments', (req: Request, res: Response) => {
    const { clause, params } = departmentScopeFilter(req, 'c');
    const category = req.query.category as string | undefined;
    const severityMin = req.query.severityMin ? Number(req.query.severityMin) : undefined;

    const rows = db
      .prepare(
        `SELECT c.id, c.department_id, c.redacted_text, c.created_at,
                ca.sentiment, ca.category, ca.severity,
                src.id as case_id, src.status as case_status, src.assigned_to, src.resolution_notes
         FROM comments c
         JOIN comment_analyses ca ON ca.comment_id = c.id
         LEFT JOIN service_recovery_cases src ON src.comment_id = c.id
         WHERE c.tenant_id = ? ${clause}
         ${category ? 'AND ca.category = ?' : ''}
         ${severityMin !== undefined ? 'AND ca.severity >= ?' : ''}
         ORDER BY c.created_at DESC
         LIMIT 200`
      )
      .all(
        ...[req.user!.tenantId, ...params, ...(category ? [category] : []), ...(severityMin !== undefined ? [severityMin] : [])]
      );
    res.json({ comments: rows });
  });

  router.patch(
    '/comments/:id/status',
    requireRole('QualityManager', 'DepartmentManager', 'SystemAdmin'),
    express.json({ limit: '8kb' }),
    (req: Request, res: Response) => {
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

      const existingCase = db.prepare('SELECT id FROM service_recovery_cases WHERE comment_id = ?').get(comment.id) as
        | { id: string }
        | undefined;

      if (existingCase) {
        db.prepare(
          `UPDATE service_recovery_cases
           SET status = ?, assigned_to = COALESCE(assigned_to, ?), resolution_notes = COALESCE(?, resolution_notes),
               closed_at = CASE WHEN ? = 'closed' THEN datetime('now') ELSE closed_at END,
               quality_approved_by = CASE WHEN ? = 'closed' THEN ? ELSE quality_approved_by END
           WHERE id = ?`
        ).run(status, req.user!.id, resolutionNotes ?? null, status, status, req.user!.id, existingCase.id);
      } else {
        db.prepare(
          `INSERT INTO service_recovery_cases (id, comment_id, tenant_id, department_id, status, assigned_to, resolution_notes)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(uid(), comment.id, comment.tenant_id, comment.department_id, status, req.user!.id, resolutionNotes ?? null);
      }

      logAudit(db, req.user!.tenantId, req.user!.id, 'case_status_change', 'service_recovery_case', comment.id, { to: status });
      res.json({ ok: true });
    }
  );

  router.get('/service-recovery/cases', (req: Request, res: Response) => {
    const { clause, params } = departmentScopeFilter(req, 'src');
    const status = req.query.status as string | undefined;
    const rows = db
      .prepare(
        `SELECT src.id, src.comment_id, src.status, src.department_id, src.assigned_to, src.opened_at, src.closed_at, src.resolution_notes,
                c.redacted_text, ca.severity, ca.category
         FROM service_recovery_cases src
         JOIN comments c ON c.id = src.comment_id
         JOIN comment_analyses ca ON ca.comment_id = c.id
         WHERE src.tenant_id = ? ${clause} ${status ? 'AND src.status = ?' : ''}
         ORDER BY src.opened_at DESC`
      )
      .all(...[req.user!.tenantId, ...params, ...(status ? [status] : [])]);
    res.json({ cases: rows });
  });

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
      for (const row of rows) {
        if (!row.phone) continue;
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
          sha256(row.phone),
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
        smsProvider: provider.name
      });
      res.status(201).json({ created, sent, smsProvider: provider.name });
    }
  );

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
          db.prepare(
            `INSERT INTO service_recovery_cases (id, comment_id, tenant_id, department_id, status, opened_at)
             VALUES (?, ?, ?, ?, 'new', ?)`
          ).run(uid(), commentId, req.user!.tenantId, body.departmentId, now);
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
    const instruments = db
      .prepare('SELECT id, code, name_ar, name_en, license_status, description_ar FROM proms_instruments WHERE tenant_id = ?')
      .all(req.user!.tenantId);
    res.json({ instruments });
  });

  router.get('/proms/pathways', (req: Request, res: Response) => {
    const pathways = db
      .prepare('SELECT id, code, name_ar, name_en FROM care_pathways WHERE tenant_id = ?')
      .all(req.user!.tenantId) as { id: string; code: string; name_ar: string; name_en: string }[];
    const withTimepoints = pathways.map((p) => ({
      ...p,
      timepoints: db
        .prepare('SELECT id, code, name_ar, offset_days, window_days FROM pathway_timepoints WHERE pathway_id = ? ORDER BY sort_order')
        .all(p.id)
    }));
    res.json({ pathways: withTimepoints });
  });

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

    const episodes = db
      .prepare('SELECT id, patient_ref_hash, surgeon_ref, start_date, status FROM patient_episodes WHERE pathway_id = ?')
      .all(pathwayId) as { id: string; patient_ref_hash: string; surgeon_ref: string; start_date: string; status: string }[];

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

  router.post(
    '/episodes',
    requireRole('SystemAdmin', 'QualityManager', 'DepartmentManager'),
    express.json({ limit: '8kb' }),
    (req: Request, res: Response) => {
      const { pathwayId, departmentId, patientRef, surgeonRef, startDate } = req.body as {
        pathwayId?: string;
        departmentId?: string;
        patientRef?: string;
        surgeonRef?: string;
        startDate?: string;
      };
      if (!pathwayId || !departmentId || !patientRef || !startDate) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const episodeId = uid();
      db.prepare(
        `INSERT INTO patient_episodes (id, tenant_id, pathway_id, department_id, patient_ref_hash, surgeon_ref, start_date, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`
      ).run(episodeId, req.user!.tenantId, pathwayId, departmentId, sha256(patientRef), surgeonRef ?? null, startDate);

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
      logAudit(db, req.user!.tenantId, req.user!.id, 'episode_created', 'patient_episode', episodeId, null);
      res.status(201).json({ id: episodeId });
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
      hisWebhookUrl: `${baseUrl}/api/webhooks/invitations`
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
