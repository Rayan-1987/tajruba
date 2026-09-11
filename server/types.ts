export type Role = 'SystemAdmin' | 'QualityManager' | 'DepartmentManager' | 'ExecutiveViewer';

// Core service lines match real Saudi hospital PX program reporting (e.g. Press Ganey
// service-line grouping): Medical Practice, Inpatient, Emergency, Ambulatory Surgery,
// Home Health, Blood Bank. Lab/Radiology/Pharmacy are NOT separate service lines — they
// are ancillary experiences a patient may have during a visit to any of these, surfaced
// as gated follow-up questions inside whichever service's survey the patient took.
// The remaining six are specialty service lines added for broader clinical coverage.
export type ServiceType = 'MP' | 'IP' | 'ED' | 'AS' | 'HH' | 'BB' | 'LD' | 'PED' | 'DIA' | 'ONC' | 'REH' | 'TEL';

export const SERVICE_TYPES: ServiceType[] = ['MP', 'IP', 'ED', 'AS', 'HH', 'BB', 'LD', 'PED', 'DIA', 'ONC', 'REH', 'TEL'];

export const SERVICE_LABELS_AR: Record<ServiceType, string> = {
  MP: 'الممارسة الطبية (العيادات)',
  IP: 'التنويم',
  ED: 'الطوارئ',
  AS: 'الجراحة النهارية',
  HH: 'الرعاية المنزلية',
  BB: 'بنك الدم',
  LD: 'الولادة',
  PED: 'الأطفال',
  DIA: 'الغسيل الكلوي',
  ONC: 'الأورام',
  REH: 'التأهيل',
  TEL: 'العيادة الافتراضية'
};

export type AncillaryService = 'LAB' | 'RAD' | 'PHARM';

export const ANCILLARY_LABELS_AR: Record<AncillaryService, string> = {
  LAB: 'المختبر',
  RAD: 'الأشعة',
  PHARM: 'الصيدلية'
};

// 'freq4' is the standard CAHPS 4-point frequency scale (Never/Sometimes/Usually/Always) used
// for process-type items, alongside the 1-5 satisfaction scale ('likert5') used for rating items.
export type AnswerType = 'likert5' | 'nps' | 'yesno' | 'freq4' | 'text' | 'vas';

export type InvitationChannel = 'sms' | 'whatsapp' | 'phone' | 'email';

// Case-mix adjustment covariate (RFP BMK-04). Age band is the single covariate implemented here
// — it mirrors the real HCAHPS case-mix adjustment methodology, which uses patient age (among a
// few other factors) to make fair comparisons between units serving different patient
// populations. Optional and only captured where a staff member plausibly knows it at invite
// time (bulk upload, phone survey, HIS webhook) — anonymous walk-up channels (QR/kiosk) never
// collect it, so case-mix adjustment silently has less data to work with there, not an error.
export type AgeBand = '<18' | '18-40' | '41-65' | '65+';
export const AGE_BANDS: AgeBand[] = ['<18', '18-40', '41-65', '65+'];

// Generalized branching-gate comparison (extends the original hardcoded "gate answer equals
// yes" check): a question with depends_on_code becomes visible only when the gate question's
// numeric answer satisfies depends_on_operator against depends_on_value. Covers both the
// original yes/no ancillary gates (eq 1) and richer conditions like "only if rated low" (lte 2).
export type DependsOnOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte';
export const DEPENDS_ON_OPERATORS: DependsOnOperator[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'];

export type InvitationStatus = 'pending' | 'sent' | 'opened' | 'completed' | 'expired';

export type CommentSentiment = 'positive' | 'negative' | 'neutral' | 'mixed';

export type CommentCategory =
  | 'nursing'
  | 'physicians'
  | 'cleanliness'
  | 'waiting_time'
  | 'appointments'
  | 'food'
  | 'parking'
  | 'billing'
  | 'communication'
  | 'privacy'
  | 'pain_management'
  | 'discharge'
  | 'safety'
  | 'staff_behavior'
  | 'facilities'
  | 'other';

export const CATEGORY_LABELS_AR: Record<CommentCategory, string> = {
  nursing: 'التمريض',
  physicians: 'الأطباء',
  cleanliness: 'النظافة',
  waiting_time: 'وقت الانتظار',
  appointments: 'المواعيد',
  food: 'الطعام',
  parking: 'المواقف',
  billing: 'الفواتير',
  communication: 'التواصل',
  privacy: 'الخصوصية',
  pain_management: 'إدارة الألم',
  discharge: 'الخروج',
  safety: 'السلامة',
  staff_behavior: 'سلوك الموظفين',
  facilities: 'المرافق',
  other: 'أخرى'
};

export type RecoveryStatus = 'new' | 'assigned' | 'in_progress' | 'closed';

export type PromLicenseStatus = 'free' | 'licensed_required';

export type PromAssignmentStatus = 'scheduled' | 'sent' | 'completed' | 'missed';

export interface JsonRecord {
  [key: string]: unknown;
}
