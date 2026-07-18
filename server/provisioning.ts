import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './db.ts';
import type { AnswerType, ServiceType } from './types.ts';

function uid(): string {
  return randomUUID();
}

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

interface InstrumentItemSeed {
  code: string;
  textAr: string;
  textEn: string;
  reverseScored: boolean;
  scaleMax: number;
}

interface InstrumentSeed {
  code: string;
  nameAr: string;
  nameEn: string;
  licenseStatus: 'free' | 'licensed_required';
  descriptionAr: string;
  items: InstrumentItemSeed[];
}

interface PathwayTimepointSeed {
  code: string;
  nameAr: string;
  offsetDays: number;
}

interface PathwaySeed {
  code: string;
  nameAr: string;
  nameEn: string;
  instrumentCodes: string[];
  timepoints: PathwayTimepointSeed[];
}

const TEMPLATE_NAMES: Record<ServiceType, { ar: string; en: string }> = {
  ED: { ar: 'استبيان تجربة الطوارئ', en: 'Emergency Experience Survey' },
  IP: { ar: 'استبيان تجربة التنويم', en: 'Inpatient Experience Survey' },
  OP: { ar: 'استبيان العيادات الخارجية', en: 'Outpatient Experience Survey' },
  HH: { ar: 'استبيان الرعاية المنزلية', en: 'Home Health Experience Survey' },
  LAB: { ar: 'استبيان تجربة المختبر', en: 'Laboratory Experience Survey' },
  RAD: { ar: 'استبيان تجربة الأشعة', en: 'Radiology Experience Survey' },
  PHARM: { ar: 'استبيان تجربة الصيدلية', en: 'Pharmacy Experience Survey' }
};

export interface TenantProvisioningResult {
  templateIds: Record<ServiceType, string>;
  questionIds: Record<string, string>;
  domainIds: Record<string, string>;
  instrumentIds: Record<string, string>;
  pathwayIds: Record<string, string>;
}

/**
 * Provisions a brand-new, independent copy of the question bank, survey templates,
 * PROMs instrument catalog and care pathway definitions for one tenant. Every hospital
 * gets its own editable copy so customizing questions/domains never affects another tenant.
 */
export function provisionTenantDefaults(db: Db, root: string, tenantId: string): TenantProvisioningResult {
  const bank: QuestionBank = JSON.parse(
    fs.readFileSync(path.join(root, 'server', 'seed-data', 'question-bank.json'), 'utf-8')
  );
  const instruments: InstrumentSeed[] = JSON.parse(
    fs.readFileSync(path.join(root, 'server', 'seed-data', 'proms-instruments.json'), 'utf-8')
  );
  const pathways: PathwaySeed[] = JSON.parse(
    fs.readFileSync(path.join(root, 'server', 'seed-data', 'care-pathways.json'), 'utf-8')
  );

  const insertDomain = db.prepare(
    'INSERT INTO question_domains (id, tenant_id, code, name_ar, name_en, service_type, benchmark_mean) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const insertQuestion = db.prepare(
    'INSERT INTO questions (id, tenant_id, code, domain_id, text_ar, text_en, answer_type, service_type, requires_alert, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insertTemplate = db.prepare(
    'INSERT INTO survey_templates (id, tenant_id, name_ar, name_en, service_type) VALUES (?, ?, ?, ?, ?)'
  );
  const insertTemplateQuestion = db.prepare(
    'INSERT INTO template_questions (id, template_id, question_id, sort_order) VALUES (?, ?, ?, ?)'
  );
  const insertInstrument = db.prepare(
    'INSERT INTO proms_instruments (id, tenant_id, code, name_ar, name_en, license_status, description_ar) VALUES (?, ?, ?, ?, ?, ?, ?)'
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

  // --- Question bank ---------------------------------------------------
  const domainIds: Record<string, string> = {};
  for (const domain of bank.domains) {
    const id = uid();
    domainIds[domain.code] = id;
    insertDomain.run(id, tenantId, domain.code, domain.nameAr, domain.nameEn, domain.service, domain.benchmark);
  }

  const questionIds: Record<string, string> = {};
  bank.questions.forEach((question, index) => {
    const id = uid();
    questionIds[question.code] = id;
    insertQuestion.run(
      id,
      tenantId,
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

  // --- Templates (one per service type) --------------------------------
  const templateIds: Record<ServiceType, string> = {} as Record<ServiceType, string>;
  for (const service of Object.keys(TEMPLATE_NAMES) as ServiceType[]) {
    const id = uid();
    templateIds[service] = id;
    insertTemplate.run(id, tenantId, TEMPLATE_NAMES[service].ar, TEMPLATE_NAMES[service].en, service);
    const questionsForService = bank.questions.filter(
      (q) => bank.domains.find((d) => d.code === q.domain)!.service === service
    );
    questionsForService.forEach((q, index) => {
      insertTemplateQuestion.run(uid(), id, questionIds[q.code], index);
    });
  }

  // --- PROMs instrument catalog ------------------------------------------
  const instrumentIds: Record<string, string> = {};
  for (const instrument of instruments) {
    const id = uid();
    instrumentIds[instrument.code] = id;
    insertInstrument.run(id, tenantId, instrument.code, instrument.nameAr, instrument.nameEn, instrument.licenseStatus, instrument.descriptionAr);
    instrument.items.forEach((item, index) => {
      insertInstrumentItem.run(uid(), id, item.code, item.textAr, item.textEn, item.reverseScored ? 1 : 0, index);
    });
  }

  // --- Care pathways -------------------------------------------------------
  const pathwayIds: Record<string, string> = {};
  for (const pathway of pathways) {
    const pathwayId = uid();
    pathwayIds[pathway.code] = pathwayId;
    insertPathway.run(pathwayId, tenantId, pathway.code, pathway.nameAr, pathway.nameEn);
    const instrumentIdsForPathway = pathway.instrumentCodes.map((code) => instrumentIds[code]);
    pathway.timepoints.forEach((tp, index) => {
      insertTimepoint.run(uid(), pathwayId, tp.code, tp.nameAr, tp.offsetDays, 14, JSON.stringify(instrumentIdsForPathway), index);
    });
  }

  return { templateIds, questionIds, domainIds, instrumentIds, pathwayIds };
}
