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

export type AnswerType = 'likert5' | 'nps' | 'yesno' | 'text' | 'vas';

export type InvitationChannel = 'sms' | 'whatsapp' | 'phone' | 'email';

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
