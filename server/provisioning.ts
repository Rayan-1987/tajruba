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

interface AncillaryItemSeed {
  textAr: string;
  textEn: string;
}

interface AncillaryServiceSeed {
  code: string;
  nameAr: string;
  nameEn: string;
  // Which primary service lines this ancillary's gated follow-up questions make sense for —
  // e.g. Radiology has no place on a Telehealth template, since a virtual visit has no
  // physical imaging touchpoint. Services not listed here never get this ancillary attached.
  applicableServices: ServiceType[];
  gate: AncillaryItemSeed;
  followUps: AncillaryItemSeed[];
}

// Real PX-program service-line categories (matches how Saudi hospitals typically report,
// e.g. Press Ganey service-line groupings): Medical Practice, Inpatient, Emergency,
// Ambulatory Surgery, Home Health, Blood Bank, plus six specialty lines with their own
// tailored PREMs content (Maternity, Pediatrics, Dialysis, Oncology, Rehabilitation,
// Telehealth) — these run alongside, not instead of, the general Inpatient survey.
const TEMPLATE_NAMES: Record<ServiceType, { ar: string; en: string }> = {
  MP: { ar: 'استبيان الممارسة الطبية (العيادات)', en: 'Medical Practice Experience Survey' },
  IP: { ar: 'استبيان تجربة التنويم', en: 'Inpatient Experience Survey' },
  ED: { ar: 'استبيان تجربة الطوارئ', en: 'Emergency Experience Survey' },
  AS: { ar: 'استبيان الجراحة النهارية', en: 'Ambulatory Surgery Experience Survey' },
  HH: { ar: 'استبيان الرعاية المنزلية', en: 'Home Health Experience Survey' },
  BB: { ar: 'استبيان بنك الدم', en: 'Blood Bank Experience Survey' },
  LD: { ar: 'استبيان تجربة الولادة', en: 'Maternity Experience Survey' },
  PED: { ar: 'استبيان تجربة الأطفال', en: 'Pediatrics Experience Survey' },
  DIA: { ar: 'استبيان تجربة الغسيل الكلوي', en: 'Dialysis Experience Survey' },
  ONC: { ar: 'استبيان تجربة رعاية الأورام', en: 'Oncology Experience Survey' },
  REH: { ar: 'استبيان تجربة التأهيل', en: 'Rehabilitation Experience Survey' },
  TEL: { ar: 'استبيان العيادة الافتراضية', en: 'Telehealth Experience Survey' }
};

/**
 * Default departments provisioned for a newly-registered hospital. Every service line gets
 * one department, EXCEPT Inpatient — a real hospital's inpatient population is never one
 * ward, so it's split into the wards found in almost every general hospital. All wards
 * under the same service line share the same survey template (the PREMs questions are the
 * same regardless of which ward), only the department (and therefore the reporting
 * breakdown) differs.
 */
export const DEFAULT_DEPARTMENTS: { service: ServiceType; nameAr: string; nameEn: string }[] = [
  { service: 'MP', nameAr: 'الممارسة الطبية (العيادات)', nameEn: 'Medical Practice Clinics' },
  { service: 'IP', nameAr: 'التنويم - الباطني', nameEn: 'Inpatient - Internal Medicine' },
  { service: 'IP', nameAr: 'التنويم - الجراحة العامة', nameEn: 'Inpatient - General Surgery' },
  { service: 'IP', nameAr: 'التنويم - العناية المركزة', nameEn: 'Inpatient - ICU' },
  { service: 'IP', nameAr: 'التنويم - النساء والولادة', nameEn: 'Inpatient - Obstetrics & Gynecology' },
  { service: 'IP', nameAr: 'التنويم - الأطفال', nameEn: 'Inpatient - Pediatrics' },
  { service: 'ED', nameAr: 'الطوارئ', nameEn: 'Emergency Department' },
  { service: 'AS', nameAr: 'الجراحة النهارية', nameEn: 'Ambulatory Surgery' },
  { service: 'HH', nameAr: 'الرعاية المنزلية', nameEn: 'Home Health' },
  { service: 'BB', nameAr: 'بنك الدم', nameEn: 'Blood Bank' },
  { service: 'LD', nameAr: 'الولادة', nameEn: 'Maternity & Labor Delivery' },
  { service: 'PED', nameAr: 'الأطفال', nameEn: 'Pediatrics' },
  { service: 'DIA', nameAr: 'الغسيل الكلوي', nameEn: 'Dialysis' },
  { service: 'ONC', nameAr: 'الأورام', nameEn: 'Oncology' },
  { service: 'REH', nameAr: 'التأهيل', nameEn: 'Rehabilitation' },
  { service: 'TEL', nameAr: 'العيادة الافتراضية', nameEn: 'Telehealth' }
];

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
 *
 * Lab/Radiology/Pharmacy are not separate service lines — they are ancillary experiences
 * appended as gated follow-up questions (yes/no gate, then 2 follow-ups) to EVERY one of
 * the six main service templates, since a patient may encounter them during any visit type.
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
  const ancillaryServices: AncillaryServiceSeed[] = JSON.parse(
    fs.readFileSync(path.join(root, 'server', 'seed-data', 'ancillary-services.json'), 'utf-8')
  );

  const insertDomain = db.prepare(
    'INSERT INTO question_domains (id, tenant_id, code, name_ar, name_en, service_type, benchmark_top_box_percent, is_ancillary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insertQuestion = db.prepare(
    `INSERT INTO questions
     (id, tenant_id, code, domain_id, text_ar, text_en, answer_type, service_type, requires_alert, sort_order, depends_on_code, cahps_item)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    'INSERT INTO proms_instrument_items (id, instrument_id, code, text_ar, text_en, reverse_scored, scale_max, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insertPathway = db.prepare(
    'INSERT INTO care_pathways (id, tenant_id, code, name_ar, name_en) VALUES (?, ?, ?, ?, ?)'
  );
  const insertTimepoint = db.prepare(
    `INSERT INTO pathway_timepoints
     (id, pathway_id, code, name_ar, offset_days, window_days, instrument_ids_json, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  // --- Question bank (per main service line) --------------------------------
  const domainIds: Record<string, string> = {};
  for (const domain of bank.domains) {
    const id = uid();
    domainIds[domain.code] = id;
    insertDomain.run(id, tenantId, domain.code, domain.nameAr, domain.nameEn, domain.service, domain.benchmark, 0);
  }

  const questionIds: Record<string, string> = {};
  bank.questions.forEach((question, index) => {
    const id = uid();
    questionIds[question.code] = id;
    // The Overall Assessment domain's rating/recommend items are the CAHPS-style items whose
    // Top Box figure is the one that matters for external reporting; other domains report a
    // mean only, matching Press Ganey's convention of showing Top Box for CAHPS items alone.
    const isOverallDomain = question.domain.endsWith('_OVR');
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
      index,
      null,
      isOverallDomain ? 1 : 0
    );
  });

  // --- Templates (one per main service line) --------------------------------
  const templateIds: Record<ServiceType, string> = {} as Record<ServiceType, string>;
  for (const service of Object.keys(TEMPLATE_NAMES) as ServiceType[]) {
    const id = uid();
    templateIds[service] = id;
    insertTemplate.run(id, tenantId, TEMPLATE_NAMES[service].ar, TEMPLATE_NAMES[service].en, service);
    const questionsForService = bank.questions.filter(
      (q) => bank.domains.find((d) => d.code === q.domain)!.service === service
    );
    let sortOrder = 0;
    questionsForService.forEach((q) => {
      insertTemplateQuestion.run(uid(), id, questionIds[q.code], sortOrder);
      sortOrder += 1;
    });

    // Ancillary (Lab/Radiology/Pharmacy) gated follow-up questions — only appended where the
    // ancillary is a plausible touchpoint for this service line (see applicableServices),
    // not blindly to every service regardless of whether the combination makes sense.
    for (const ancillary of ancillaryServices.filter((a) => a.applicableServices.includes(service))) {
      const domainCode = `${service}_${ancillary.code}`;
      const domainId = uid();
      domainIds[domainCode] = domainId;
      insertDomain.run(domainId, tenantId, domainCode, ancillary.nameAr, ancillary.nameEn, service, 70.0, 1);

      const gateCode = `${service}-${ancillary.code}-GATE`;
      const gateId = uid();
      questionIds[gateCode] = gateId;
      insertQuestion.run(gateId, tenantId, gateCode, domainId, ancillary.gate.textAr, ancillary.gate.textEn, 'yesno', service, 0, sortOrder, null, 0);
      insertTemplateQuestion.run(uid(), id, gateId, sortOrder);
      sortOrder += 1;

      ancillary.followUps.forEach((followUp, followUpIndex) => {
        const followUpCode = `${service}-${ancillary.code}-Q${followUpIndex + 1}`;
        const followUpId = uid();
        questionIds[followUpCode] = followUpId;
        insertQuestion.run(
          followUpId,
          tenantId,
          followUpCode,
          domainId,
          followUp.textAr,
          followUp.textEn,
          'likert5',
          service,
          0,
          sortOrder,
          gateCode,
          0
        );
        insertTemplateQuestion.run(uid(), id, followUpId, sortOrder);
        sortOrder += 1;
      });
    }
  }

  // --- PROMs instrument catalog ------------------------------------------
  const instrumentIds: Record<string, string> = {};
  for (const instrument of instruments) {
    const id = uid();
    instrumentIds[instrument.code] = id;
    insertInstrument.run(id, tenantId, instrument.code, instrument.nameAr, instrument.nameEn, instrument.licenseStatus, instrument.descriptionAr);
    instrument.items.forEach((item, index) => {
      insertInstrumentItem.run(uid(), id, item.code, item.textAr, item.textEn, item.reverseScored ? 1 : 0, item.scaleMax, index);
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
