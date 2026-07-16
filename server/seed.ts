import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './db.ts';
import { hashPassword } from './auth.ts';
import { redactPii, createDefaultAnalyzer, shouldAlert } from './comments.ts';
import { scoreInstrument, VAS_PAIN, type InstrumentItemValue } from './scoring.ts';
import type { AnswerType, ServiceType } from './types.ts';

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

function sampleAnswer(rng: () => number, type: AnswerType, benchmark: number): number {
  if (type === 'nps') {
    return Math.round(clamp(benchmark * 2 + (rng() - 0.5) * 6, 0, 10));
  }
  return Math.round(clamp(benchmark + (rng() - 0.5) * 2.6, 1, 5));
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
  const insertDomain = db.prepare(
    'INSERT INTO question_domains (id, code, name_ar, name_en, service_type, benchmark_mean) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insertQuestion = db.prepare(
    'INSERT INTO questions (id, code, domain_id, text_ar, text_en, answer_type, service_type, requires_alert, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insertTemplate = db.prepare(
    'INSERT INTO survey_templates (id, tenant_id, name_ar, name_en, service_type) VALUES (?, ?, ?, ?, ?)'
  );
  const insertTemplateQuestion = db.prepare(
    'INSERT INTO template_questions (id, template_id, question_id, sort_order) VALUES (?, ?, ?, ?)'
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
  const insertInstrument = db.prepare(
    'INSERT INTO proms_instruments (id, code, name_ar, name_en, license_status, description_ar) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insertInstrumentItem = db.prepare(
    'INSERT INTO proms_instrument_items (id, instrument_id, code, text_ar, text_en, reverse_scored, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const insertPathway = db.prepare(
    'INSERT INTO care_pathways (id, tenant_id, code, name_ar, name_en) VALUES (?, ?, ?, ?, ?)'
  );
  const insertTimepoint = db.prepare(
    `INSERT INTO pathway_timepoints
     (id, pathway_id, code, name_ar, offset_days, window_days, instrument_ids_json, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
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

  const serviceDeptNames: Record<ServiceType, { ar: string; en: string }> = {
    ED: { ar: 'الطوارئ', en: 'Emergency Department' },
    IP: { ar: 'التنويم - الباطني', en: 'Inpatient - Internal Medicine' },
    OP: { ar: 'العيادات الخارجية', en: 'Outpatient Clinics' },
    HH: { ar: 'الرعاية المنزلية', en: 'Home Health' },
    LAB: { ar: 'المختبر', en: 'Laboratory' },
    RAD: { ar: 'الأشعة', en: 'Radiology' },
    PHARM: { ar: 'الصيدلية', en: 'Pharmacy' }
  };
  const departmentIds: Record<ServiceType, string> = {} as Record<ServiceType, string>;
  for (const [service, names] of Object.entries(serviceDeptNames) as [ServiceType, { ar: string; en: string }][]) {
    const id = uid();
    departmentIds[service] = id;
    insertDept.run(id, tenantId, facilityId, names.ar, names.en, service);
  }

  // --- Users -----------------------------------------------------------------
  const adminId = uid();
  insertUser.run(adminId, tenantId, 'admin@tajruba.sa', hashPassword(DEMO_PASSWORDS.admin), 'SystemAdmin', null, 'مدير النظام');
  const qualityId = uid();
  insertUser.run(qualityId, tenantId, 'quality@tajruba.sa', hashPassword(DEMO_PASSWORDS.quality), 'QualityManager', null, 'مدير الجودة');
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

  // --- Question bank -----------------------------------------------------
  const domainIds: Record<string, string> = {};
  for (const domain of bank.domains) {
    const id = uid();
    domainIds[domain.code] = id;
    insertDomain.run(id, domain.code, domain.nameAr, domain.nameEn, domain.service, domain.benchmark);
  }

  const questionIds: Record<string, string> = {};
  const questionMeta: Record<string, QuestionSeed> = {};
  bank.questions.forEach((question, index) => {
    const id = uid();
    questionIds[question.code] = id;
    questionMeta[id] = question;
    insertQuestion.run(
      id,
      question.code,
      domainIds[question.domain],
      question.textAr,
      question.textEn,
      question.type,
      bank.domains.find((d) => d.code === question.domain)!.service,
      question.requiresAlert ? 1 : 0,
      index
    );
  });

  // --- Templates (one per service type) -----------------------------------
  const templateIds: Record<ServiceType, string> = {} as Record<ServiceType, string>;
  const templateNames: Record<ServiceType, { ar: string; en: string }> = {
    ED: { ar: 'استبيان تجربة الطوارئ', en: 'Emergency Experience Survey' },
    IP: { ar: 'استبيان تجربة التنويم', en: 'Inpatient Experience Survey' },
    OP: { ar: 'استبيان العيادات الخارجية', en: 'Outpatient Experience Survey' },
    HH: { ar: 'استبيان الرعاية المنزلية', en: 'Home Health Experience Survey' },
    LAB: { ar: 'استبيان تجربة المختبر', en: 'Laboratory Experience Survey' },
    RAD: { ar: 'استبيان تجربة الأشعة', en: 'Radiology Experience Survey' },
    PHARM: { ar: 'استبيان تجربة الصيدلية', en: 'Pharmacy Experience Survey' }
  };
  for (const service of Object.keys(templateNames) as ServiceType[]) {
    const id = uid();
    templateIds[service] = id;
    insertTemplate.run(id, tenantId, templateNames[service].ar, templateNames[service].en, service);
    const questionsForService = bank.questions.filter(
      (q) => bank.domains.find((d) => d.code === q.domain)!.service === service
    );
    questionsForService.forEach((q, index) => {
      insertTemplateQuestion.run(uid(), id, questionIds[q.code], index);
    });
  }

  // --- Demo responses across the last 6 months per department ------------
  let commentIndex = 0;
  for (const service of Object.keys(templateNames) as ServiceType[]) {
    const deptId = departmentIds[service];
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

      // ~20% of responses include a free-text comment.
      if (rng() < 0.2) {
        const rawText =
          service === 'ED' && commentIndex === 0
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
    { token: 'demo-op-token', service: 'OP' }
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

  // --- PROMs instruments ---------------------------------------------------
  const phq9Id = uid();
  insertInstrument.run(phq9Id, 'PHQ9', 'مقياس صحة المريض للاكتئاب (PHQ-9)', 'Patient Health Questionnaire-9', 'free', 'أداة فحص فرز للاكتئاب، متاحة للاستخدام العام دون رسوم ترخيص.');
  const phq9Items = [
    'قلة الاهتمام أو المتعة في القيام بالأشياء',
    'الشعور بالإحباط أو الاكتئاب أو اليأس',
    'صعوبة في النوم أو النوم لفترة طويلة جدًا',
    'الشعور بالتعب أو قلة الطاقة',
    'ضعف الشهية أو الإفراط في الأكل',
    'الشعور السلبي تجاه النفس',
    'صعوبة التركيز',
    'بطء أو تسارع ملحوظ في الحركة أو الكلام',
    'أفكار بإيذاء النفس'
  ];
  phq9Items.forEach((text, i) => {
    insertInstrumentItem.run(uid(), phq9Id, `PHQ9-${i + 1}`, text, `PHQ-9 item ${i + 1}`, 0, i);
  });

  const gad7Id = uid();
  insertInstrument.run(gad7Id, 'GAD7', 'مقياس اضطراب القلق العام (GAD-7)', 'Generalized Anxiety Disorder-7', 'free', 'أداة فحص فرز للقلق العام، متاحة للاستخدام العام دون رسوم ترخيص.');
  const gad7Items = [
    'الشعور بالعصبية أو القلق',
    'عدم القدرة على إيقاف القلق أو التحكم به',
    'القلق الزائد حول أمور مختلفة',
    'صعوبة الاسترخاء',
    'التململ لدرجة صعوبة الجلوس بهدوء',
    'سهولة الانزعاج أو التهيج',
    'الشعور بالخوف من حدوث شيء فظيع'
  ];
  gad7Items.forEach((text, i) => {
    insertInstrumentItem.run(uid(), gad7Id, `GAD7-${i + 1}`, text, `GAD-7 item ${i + 1}`, 0, i);
  });

  const vasId = uid();
  insertInstrument.run(vasId, 'VAS_PAIN', 'مقياس الألم البصري التناظري (VAS)', 'Visual Analogue Scale - Pain', 'free', 'مقياس ألم من بند واحد، حر الاستخدام.');
  insertInstrumentItem.run(uid(), vasId, 'VAS-1', 'قيّم شدة الألم الذي تشعر به الآن من 0 (لا يوجد ألم) إلى 10 (أسوأ ألم يمكن تخيله)', 'Rate your current pain from 0 (no pain) to 10 (worst pain imaginable)', 0, 0);

  const oxfordId = uid();
  insertInstrument.run(
    oxfordId,
    'OXFORD_KNEE',
    'مقياس أكسفورد للركبة (Oxford Knee Score)',
    'Oxford Knee Score',
    'licensed_required',
    'أداة مرخّصة من جامعة أكسفورد. البنود الفعلية محجوبة حتى يتم توثيق الترخيص التجاري والنسخة العربية المعتمدة.'
  );
  for (let i = 1; i <= 12; i++) {
    insertInstrumentItem.run(uid(), oxfordId, `OKS-${i}`, `بند مرخّص #${i} — يتطلب ترخيصًا تجاريًا لعرض النص الفعلي`, `Licensed item #${i} — commercial license required to display actual text`, 0, i - 1);
  }

  const eq5dId = uid();
  insertInstrument.run(
    eq5dId,
    'EQ5D5L',
    'مقياس جودة الحياة (EQ-5D-5L)',
    'EuroQol EQ-5D-5L',
    'licensed_required',
    'أداة مرخّصة من EuroQol Group. البنود الفعلية محجوبة حتى يتم توثيق الترخيص.'
  );
  for (let i = 1; i <= 5; i++) {
    insertInstrumentItem.run(uid(), eq5dId, `EQ5D-${i}`, `بُعد مرخّص #${i} — يتطلب ترخيصًا لعرض النص الفعلي`, `Licensed dimension #${i} — license required to display actual text`, 0, i - 1);
  }

  // --- Care pathway: knee replacement, tracked with the free VAS pain scale ---
  const pathwayId = uid();
  insertPathway.run(pathwayId, tenantId, 'KNEE_REPLACEMENT', 'مسار استبدال مفصل الركبة', 'Knee Replacement Pathway');

  const timepointDefs = [
    { code: 'BASELINE', nameAr: 'ما قبل العملية', offset: 0 },
    { code: 'W6', nameAr: '6 أسابيع', offset: 42 },
    { code: 'M3', nameAr: '3 أشهر', offset: 90 },
    { code: 'M6', nameAr: '6 أشهر', offset: 180 },
    { code: 'M12', nameAr: '12 شهر', offset: 365 }
  ];
  const timepointIds: string[] = [];
  timepointDefs.forEach((tp, index) => {
    const id = uid();
    timepointIds.push(id);
    insertTimepoint.run(id, pathwayId, tp.code, tp.nameAr, tp.offset, 14, JSON.stringify([vasId]), index);
  });

  const episodeCount = 10;
  for (let e = 0; e < episodeCount; e++) {
    const startAgeDays = 30 + Math.round(rng() * 335);
    const startDate = daysAgo(startAgeDays);
    const episodeId = uid();
    insertEpisode.run(
      episodeId,
      tenantId,
      pathwayId,
      departmentIds.IP,
      sha256(`patient-${e}-${rng()}`),
      `د. جراح ${(e % 3) + 1}`,
      startDate,
      startAgeDays > 365 ? 'completed' : 'active'
    );

    const baselinePain = 7 + Math.round(rng() * 2); // 7-9
    let baselineRaw: number | null = null;
    const improvementRate = 0.5 + rng() * 1.2; // pain points recovered per elapsed timepoint

    timepointDefs.forEach((tp, tIndex) => {
      const dueDate = addDays(startDate, tp.offset);
      const isDue = new Date(dueDate).getTime() <= Date.now();
      const assignmentId = uid();
      insertAssignment.run(assignmentId, episodeId, timepointIds[tIndex], vasId, dueDate, isDue ? 'completed' : 'scheduled');

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

  // --- Audit trail sample ---------------------------------------------------
  insertAudit.run(uid(), tenantId, adminId, 'seed_completed', 'system', null, JSON.stringify({ note: 'Demo data generated' }));
  insertAudit.run(uid(), tenantId, qualityId, 'login', 'session', null, null);
  insertAudit.run(uid(), tenantId, deptUserId, 'case_status_change', 'service_recovery_case', null, JSON.stringify({ to: 'in_progress' }));
}
