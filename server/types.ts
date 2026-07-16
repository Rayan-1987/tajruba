export type Role = 'SystemAdmin' | 'QualityManager' | 'DepartmentManager' | 'ExecutiveViewer';

export type ServiceType = 'ED' | 'IP' | 'OP' | 'HH' | 'LAB' | 'RAD' | 'PHARM';

export const SERVICE_TYPES: ServiceType[] = ['ED', 'IP', 'OP', 'HH', 'LAB', 'RAD', 'PHARM'];

export const SERVICE_LABELS_AR: Record<ServiceType, string> = {
  ED: 'الطوارئ',
  IP: 'التنويم',
  OP: 'العيادات الخارجية',
  HH: 'الرعاية المنزلية',
  LAB: 'المختبر',
  RAD: 'الأشعة',
  PHARM: 'الصيدلية'
};

export type AnswerType = 'likert5' | 'nps' | 'yesno' | 'text' | 'vas';

export type InvitationChannel = 'sms' | 'whatsapp' | 'phone';

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
