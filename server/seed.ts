import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './db.ts';
import { hashPassword } from './auth.ts';
import { redactPii, createDefaultAnalyzer, shouldAlert } from './comments.ts';
import { scoreInstrument, VAS_PAIN, type InstrumentItemValue } from './scoring.ts';
import { DEFAULT_DEPARTMENTS, provisionTenantDefaults } from './provisioning.ts';
import { SERVICE_TYPES, type AnswerType, type ServiceType } from './types.ts';

interface DomainSeed {
  code: string;
  nameAr: string;
  nameEn: string;
  service: ServiceType;
  benchmark: number;
}

interface QuestionSeed {
  code: string;
  domain: string;
  textAr: string;
  textEn: string;
  type: AnswerType;
  requiresAlert?: boolean;
}

interface QuestionBank {
  domains: DomainSeed[];
  questions: QuestionSeed[];
}

function uid(): string {
  return randomUUID();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// Deterministic PRNG (mulberry32) so demo data is reproducible across seed runs.
function mulberry32(seed: number): () => number {
  let s = seed;
  return function next() {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// Domain benchmarks are stored as a 0-100 top-box percentage (HCAHPS convention). Demo data
// generation still needs a 1-5 Likert target to sample around, so approximate the equivalent
// mean from the percentage (e.g. 68% top-box -> ~3.7 mean, 84% top-box -> ~4.4 mean).
function benchmarkPercentToMean(percent: number): number {
  return clamp(1 + (percent / 100) * 4, 1, 5);
}

function sampleAnswer(rng: () => number, type: AnswerType, benchmarkPercent: number): number {
  const mean = benchmarkPercentToMean(benchmarkPercent);
  if (type === 'nps') {
    return Math.round(clamp(mean * 2 + (rng() - 0.5) * 6, 0, 10));
  }
  return Math.round(clamp(mean + (rng() - 0.5) * 2.6, 1, 5));
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso);
  d.setDate(d.getDate() + n);
  return d.toISOString();
}

const DEMO_PASSWORDS = {
  admin: 'Tajruba123!',
  quality: 'Quality123!',
  department: 'Department123!',
  executive: 'Executive123!'
};

export function seedDatabase(db: Db, root: string): void {
  const existing = db.prepare('SELECT COUNT(*) as count FROM tenants').get() as { count: number };
  if (existing.count > 0) return;

  const bank: QuestionBank = JSON.parse(
    fs.readFileSync(path.join(root, 'server', 'seed-data', 'question-bank.json'), 'utf-8')
  );
  const commentPool: string[] = JSON.parse(
    fs.readFileSync(path.join(root, 'server', 'seed-data', 'comments-pool.json'), 'utf-8')
  );

  const rng = mulberry32(42);
  const analyzer = createDefaultAnalyzer();

  const insertTenant = db.prepare('INSERT INTO tenants (id, name_ar, name_en, slug) VALUES (?, ?, ?, ?)');
  const insertFacility = db.prepare('INSERT INTO facilities (id, tenant_id, name_ar, name_en) VALUES (?, ?, ?, ?)');
  const insertDept = db.prepare(
    'INSERT INTO departments (id, tenant_id, facility_id, name_ar, name_en, service_type) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insertUser = db.prepare(
    'INSERT INTO users (id, tenant_id, email, password_hash, role, department_id, full_name) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const insertInvitation = db.prepare(
    `INSERT INTO survey_invitations
     (id, tenant_id, template_id, department_id, service_type, token_hash, patient_phone_hash, channel, status, expires_at, sent_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertResponse = db.prepare(
    'INSERT INTO survey_responses (id, invitation_id, tenant_id, started_at, submitted_at, language, mode) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const insertAnswer = db.prepare(
    'INSERT INTO answers (id, response_id, question_id, value_numeric) VALUES (?, ?, ?, ?)'
  );
  const insertComment = db.prepare(
    'INSERT INTO comments (id, response_id, tenant_id, department_id, raw_text, redacted_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const insertAnalysis = db.prepare(
    'INSERT INTO comment_analyses (id, comment_id, sentiment, category, severity, analyzer) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insertAlert = db.prepare(
    'INSERT INTO comment_alerts (id, comment_id, tenant_id, severity) VALUES (?, ?, ?, ?)'
  );
  const insertRecovery = db.prepare(
    `INSERT INTO service_recovery_cases
     (id, comment_id, tenant_id, department_id, status, assigned_to, opened_at, closed_at, resolution_notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertAudit = db.prepare(
    'INSERT INTO audit_logs (id, tenant_id, user_id, action, entity, entity_id, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const insertEpisode = db.prepare(
    `INSERT INTO patient_episodes
     (id, tenant_id, pathway_id, department_id, patient_ref_hash, surgeon_ref, start_date, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertAssignment = db.prepare(
    'INSERT INTO prom_assignments (id, episode_id, timepoint_id, instrument_id, due_date, status) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insertScore = db.prepare(
    'INSERT INTO prom_scores (id, assignment_id, instrument_id, raw_score, band, baseline_score, delta, mcid_met) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );

  // --- Tenancy -------------------------------------------------------------
  const tenantId = uid();
  insertTenant.run(tenantId, 'مستشفى تجربة التخصصي', 'Tajruba Specialist Hospital', 'tajruba-demo');

  const facilityId = uid();
  insertFacility.run(facilityId, tenantId, 'المستشفى الرئيسي', 'Main Campus');

  // Inpatient is split into its usual wards (not one lump department) — same default
  // breakdown a newly self-registered hospital gets, so the demo tenant is representative.
  const departmentsByService = Object.fromEntries(SERVICE_TYPES.map((s) => [s, [] as string[]])) as Record<
    ServiceType,
    string[]
  >;
  for (const dept of DEFAULT_DEPARTMENTS) {
    const id = uid();
    departmentsByService[dept.service].push(id);
    insertDept.run(id, tenantId, facilityId, dept.nameAr, dept.nameEn, dept.service);
  }
  const departmentIds = Object.fromEntries(SERVICE_TYPES.map((s) => [s, departmentsByService[s][0]])) as Record<
    ServiceType,
    string
  >;

  // --- Users -----------------------------------------------------------------
  const adminId = uid();
  insertUser.run(adminId, tenantId, 'admin@tajruba.sa', hashPassword(DEMO_PASSWORDS.admin), 'SystemAdmin', null, 'مدير النظام');
  const qualityId = uid();
  insertUser.run(qualityId, tenantId, 'quality@tajruba.sa', hashPassword(DEMO_PASSWORDS.quality), 'QualityManager', null, 'إدارة تجربة المريض');
  const deptUserId = uid();
  insertUser.run(
    deptUserId,
    tenantId,
    'department@tajruba.sa',
    hashPassword(DEMO_PASSWORDS.department),
    'DepartmentManager',
    departmentIds.ED,
    'مدير قسم الطوارئ'
  );
  const execId = uid();
  insertUser.run(execId, tenantId, 'executive@tajruba.sa', hashPassword(DEMO_PASSWORDS.executive), 'ExecutiveViewer', null, 'مسؤول تنفيذي');

  // --- Question bank, templates, PROMs catalog, care pathways (per-tenant copy) ---
  const { templateIds, questionIds, instrumentIds, pathwayIds } = provisionTenantDefaults(db, root, tenantId);

  // --- Demo responses across the last 6 months per department (each Inpatient ward gets its own) ---
  let commentIndex = 0;
  const nextDeptIndexByService = Object.fromEntries(SERVICE_TYPES.map((s) => [s, 0])) as Record<ServiceType, number>;
  for (const deptDef of DEFAULT_DEPARTMENTS) {
    const service = deptDef.service;
    const deptId = departmentsByService[service][nextDeptIndexByService[service]];
    const isFirstDeptForService = nextDeptIndexByService[service] === 0;
    nextDeptIndexByService[service] += 1;

    const templateId = templateIds[service];
    const questionsForService = bank.questions.filter(
      (q) => bank.domains.find((d) => d.code === q.domain)!.service === service
    );
    const responseCount = 40;
    for (let i = 0; i < responseCount; i++) {
      const ageInDays = Math.round(rng() * 180);
      const submittedAt = daysAgo(ageInDays);
      const invitationId = uid();
      const rawToken = uid();
      insertInvitation.run(
        invitationId,
        tenantId,
        templateId,
        deptId,
        service,
        sha256(rawToken),
        sha256(`05${Math.floor(rng() * 100000000)}`),
        rng() > 0.5 ? 'sms' : 'whatsapp',
        'completed',
        addDays(submittedAt, 7),
        submittedAt,
        submittedAt
      );
      const responseId = uid();
      insertResponse.run(responseId, invitationId, tenantId, submittedAt, submittedAt, 'ar', 'mobile');

      for (const question of questionsForService) {
        const domain = bank.domains.find((d) => d.code === question.domain)!;
        const value = sampleAnswer(rng, question.type, domain.benchmark);
        insertAnswer.run(uid(), responseId, questionIds[question.code], value);
      }

      // The very first ED response always carries the critical chest-pain comment, so the
      // demo (and tests) always have at least one high-severity service recovery case to show,
      // regardless of how the deterministic RNG sequence shifts as the question bank changes.
      const forceCriticalComment = service === 'ED' && i === 0;
      if (forceCriticalComment || rng() < 0.2) {
        const rawText = forceCriticalComment
          ? 'أشعر بألم شديد بالصدر منذ الخروج ولم يتابع معي أحد.'
          : commentPool[commentIndex % commentPool.length];
        commentIndex += 1;
        const redacted = redactPii(rawText);
        const analysis = analyzer.analyze(redacted);
        const commentId = uid();
        insertComment.run(commentId, responseId, tenantId, deptId, rawText, redacted, submittedAt);
        insertAnalysis.run(uid(), commentId, analysis.sentiment, analysis.category, analysis.severity, analysis.analyzer);

        if (shouldAlert(analysis.severity)) {
          insertAlert.run(uid(), commentId, tenantId, analysis.severity);
        }
        if (analysis.severity >= 3) {
          const statusRoll = rng();
          const status = statusRoll < 0.25 ? 'new' : statusRoll < 0.5 ? 'assigned' : statusRoll < 0.75 ? 'in_progress' : 'closed';
          insertRecovery.run(
            uid(),
            commentId,
            tenantId,
            deptId,
            status,
            status === 'new' ? null : deptUserId,
            submittedAt,
            status === 'closed' ? addDays(submittedAt, 3) : null,
            status === 'closed' ? 'تم التواصل مع المريض وحل الملاحظة، وتوثيق الإجراء التصحيحي.' : null
          );
        }
      }
    }
  }

  // --- A few open (uncompleted) demo invitations the reviewer can fill in ---
  const demoTokens: { token: string; service: ServiceType }[] = [
    { token: 'demo-ed-token', service: 'ED' },
    { token: 'demo-ip-token', service: 'IP' },
    { token: 'demo-mp-token', service: 'MP' },
    { token: 'demo-as-token', service: 'AS' }
  ];
  for (const demo of demoTokens) {
    insertInvitation.run(
      uid(),
      tenantId,
      templateIds[demo.service],
      departmentIds[demo.service],
      demo.service,
      sha256(demo.token),
      sha256('0500000000'),
      'sms',
      'sent',
      addDays(new Date().toISOString(), 14),
      new Date().toISOString(),
      new Date().toISOString()
    );
  }

  // --- PROMs care pathways: generate demo episodes with real VAS pain scores ---
  const vasId = instrumentIds.VAS_PAIN;

  function generatePathwayEpisodes(pathwayCode: string, departmentId: string, episodeCount: number, surgeonPrefix: string) {
    const pathwayId = pathwayIds[pathwayCode];
    const timepoints = db
      .prepare('SELECT id, code, offset_days FROM pathway_timepoints WHERE pathway_id = ? ORDER BY sort_order')
      .all(pathwayId) as { id: string; code: string; offset_days: number }[];

    for (let e = 0; e < episodeCount; e++) {
      const startAgeDays = 30 + Math.round(rng() * 335);
      const startDate = daysAgo(startAgeDays);
      const episodeId = uid();
      insertEpisode.run(
        episodeId,
        tenantId,
        pathwayId,
        departmentId,
        sha256(`${pathwayCode}-patient-${e}-${rng()}`),
        `${surgeonPrefix} ${(e % 3) + 1}`,
        startDate,
        startAgeDays > 365 ? 'completed' : 'active'
      );

      const baselinePain = 6 + Math.round(rng() * 3); // 6-9
      let baselineRaw: number | null = null;
      const improvementRate = 0.5 + rng() * 1.2;

      timepoints.forEach((tp, tIndex) => {
        const dueDate = addDays(startDate, tp.offset_days);
        const isDue = new Date(dueDate).getTime() <= Date.now();
        const assignmentId = uid();
        insertAssignment.run(assignmentId, episodeId, tp.id, vasId, dueDate, isDue ? 'completed' : 'scheduled');

        if (!isDue) return;

        const painNow = tIndex === 0 ? baselinePain : clamp(baselinePain - improvementRate * tIndex, 0, 10);
        const items: InstrumentItemValue[] = [{ code: 'VAS-1', value: Math.round(painNow), reverseScored: false, scaleMax: 10 }];
        const result = scoreInstrument(VAS_PAIN, items, tIndex === 0 ? null : baselineRaw);
        if (tIndex === 0) baselineRaw = result.raw;

        insertScore.run(
          uid(),
          assignmentId,
          vasId,
          result.raw,
          result.band,
          result.baseline,
          result.delta,
          result.mcidMet === null ? null : result.mcidMet ? 1 : 0
        );
      });
    }
  }

  generatePathwayEpisodes('KNEE_REPLACEMENT', departmentIds.IP, 10, 'د. جراح عظام');
  generatePathwayEpisodes('LOW_BACK_PAIN', departmentIds.MP, 6, 'د. استشاري ظهر');

  // --- Audit trail sample ---------------------------------------------------
  insertAudit.run(uid(), tenantId, adminId, 'seed_completed', 'system', null, JSON.stringify({ note: 'Demo data generated' }));
  insertAudit.run(uid(), tenantId, qualityId, 'login', 'session', null, null);
  insertAudit.run(uid(), tenantId, deptUserId, 'case_status_change', 'service_recovery_case', null, JSON.stringify({ to: 'in_progress' }));
}
