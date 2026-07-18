export type Role = 'SystemAdmin' | 'QualityManager' | 'DepartmentManager' | 'ExecutiveViewer';

export type ServiceType = 'MP' | 'IP' | 'ED' | 'AS' | 'HH' | 'BB';

export const SERVICE_LABELS_AR: Record<ServiceType, string> = {
  MP: 'الممارسة الطبية (العيادات)',
  IP: 'التنويم',
  ED: 'الطوارئ',
  AS: 'الجراحة النهارية',
  HH: 'الرعاية المنزلية',
  BB: 'بنك الدم'
};

export const CATEGORY_LABELS_AR: Record<string, string> = {
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

export const STATUS_LABELS_AR: Record<string, string> = {
  new: 'جديد',
  assigned: 'مُسند',
  in_progress: 'تحت المعالجة',
  closed: 'مغلق'
};

export const SENTIMENT_LABELS_AR: Record<string, string> = {
  positive: 'إيجابي',
  negative: 'سلبي',
  neutral: 'محايد',
  mixed: 'مختلط'
};

export interface SessionUser {
  id: string;
  tenantId: string;
  role: Role;
  departmentId: string | null;
  fullName: string;
  email: string;
}

export interface Department {
  id: string;
  name_ar: string;
  name_en: string;
  service_type: ServiceType;
}
