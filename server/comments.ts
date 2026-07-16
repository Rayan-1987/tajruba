import type { CommentCategory, CommentSentiment } from './types.ts';

// PDPL safeguard: every comment is redacted BEFORE any analysis (local or external) touches it.
// This module ships a local rule-based analyzer so the pilot works without sending patient
// free-text to any third-party API. A future `ClaudeCommentAnalyzer` can implement the same
// `CommentAnalyzer` interface and be swapped in via `createDefaultAnalyzer`, but it must only
// ever receive `redactedText`, never `rawText`.

const PHONE_PATTERN = /(?:\+?966|0)?5\d{8}\b/g;
const GENERIC_PHONE_PATTERN = /\b\d{9,12}\b/g;
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const MRN_PATTERN = /\b(?:MRN|mrn|ملف|سجل)[\s#:-]*\d{4,10}\b/g;
const NATIONAL_ID_PATTERN = /\b[12]\d{9}\b/g;

export function redactPii(text: string): string {
  return text
    .replace(MRN_PATTERN, '[رقم ملف]')
    .replace(EMAIL_PATTERN, '[بريد إلكتروني]')
    .replace(NATIONAL_ID_PATTERN, '[هوية]')
    .replace(PHONE_PATTERN, '[رقم جوال]')
    .replace(GENERIC_PHONE_PATTERN, '[رقم]');
}

export interface CommentAnalysisResult {
  sentiment: CommentSentiment;
  category: CommentCategory;
  severity: number;
  analyzer: string;
}

export interface CommentAnalyzer {
  name: string;
  analyze(redactedText: string): CommentAnalysisResult;
}

const CATEGORY_KEYWORDS: Record<CommentCategory, string[]> = {
  nursing: ['تمريض', 'ممرض', 'ممرضة', 'nurse', 'nursing'],
  physicians: ['طبيب', 'دكتور', 'الطبيبة', 'استشاري', 'physician', 'doctor'],
  cleanliness: ['نظافة', 'وسخ', 'قذر', 'غير نظيف', 'clean', 'dirty', 'hygiene'],
  waiting_time: ['انتظار', 'تأخير', 'وقت طويل', 'دور', 'wait', 'delay', 'queue'],
  appointments: ['موعد', 'حجز', 'appointment', 'booking', 'reschedule'],
  food: ['طعام', 'أكل', 'وجبة', 'food', 'meal'],
  parking: ['موقف', 'مواقف', 'parking'],
  billing: ['فاتورة', 'تكلفة', 'دفع', 'تأمين', 'billing', 'insurance', 'invoice'],
  communication: ['تواصل', 'شرح', 'معلومات', 'communication', 'explain'],
  privacy: ['خصوصية', 'privacy', 'confidential'],
  safety: ['سقوط', 'خطأ دواء', 'إصابة', 'نزيف', 'صدر', 'تهديد', 'اعتداء', 'إساءة', 'safety', 'fall', 'assault', 'threat'],
  pain_management: ['ألم', 'وجع', 'مسكن', 'pain'],
  discharge: ['خروج', 'تخريج', 'discharge'],
  staff_behavior: ['سلوك', 'وقاحة', 'قلة احترام', 'rude', 'behavior', 'attitude'],
  facilities: ['مرافق', 'غرفة', 'سرير', 'مكيف', 'facility', 'room', 'bed'],
  other: []
};

const POSITIVE_WORDS = ['ممتاز', 'رائع', 'شكرا', 'شكراً', 'راضي', 'محترم', 'سريع', 'ممتازة', 'excellent', 'great', 'thank', 'good', 'satisfied'];
const NEGATIVE_WORDS = ['سيء', 'سيئة', 'بطيء', 'غير راضي', 'مقصر', 'إهمال', 'اهمال', 'وقح', 'bad', 'poor', 'slow', 'rude', 'terrible', 'unacceptable'];

const CRITICAL_SAFETY_TERMS = ['ألم شديد بالصدر', 'ألم بالصدر', 'نزيف', 'سقوط', 'خطأ دواء', 'اعتداء', 'إساءة', 'تهديد', 'chest pain', 'assault', 'threat'];
const HIGH_SEVERITY_TERMS = ['إهمال', 'اهمال', 'خطير', 'شكوى رسمية', 'تصعيد', 'neglect', 'escalate'];

function detectCategory(text: string): CommentCategory {
  const lower = text.toLowerCase();
  let best: CommentCategory = 'other';
  let bestHits = 0;
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS) as [CommentCategory, string[]][]) {
    const hits = keywords.filter((kw) => lower.includes(kw.toLowerCase())).length;
    if (hits > bestHits) {
      bestHits = hits;
      best = category;
    }
  }
  return best;
}

function detectSentiment(text: string): CommentSentiment {
  const lower = text.toLowerCase();
  const hasPositive = POSITIVE_WORDS.some((w) => lower.includes(w.toLowerCase()));
  const hasNegative = NEGATIVE_WORDS.some((w) => lower.includes(w.toLowerCase()));
  if (hasPositive && hasNegative) return 'mixed';
  if (hasPositive) return 'positive';
  if (hasNegative) return 'negative';
  return 'neutral';
}

function detectSeverity(text: string, category: CommentCategory, sentiment: CommentSentiment): number {
  const lower = text.toLowerCase();
  if (CRITICAL_SAFETY_TERMS.some((t) => lower.includes(t.toLowerCase()))) return 5;
  if (category === 'safety') return 4;
  if (HIGH_SEVERITY_TERMS.some((t) => lower.includes(t.toLowerCase()))) return 4;
  if (sentiment === 'negative') return 3;
  if (sentiment === 'mixed') return 2;
  return 1;
}

export class RuleBasedAnalyzer implements CommentAnalyzer {
  name = 'rule-based-v1';

  analyze(redactedText: string): CommentAnalysisResult {
    const category = detectCategory(redactedText);
    let sentiment = detectSentiment(redactedText);
    const severity = detectSeverity(redactedText, category, sentiment);
    // A critical/high-severity report is never truly neutral, even if it used no explicit negative words.
    if (severity >= 4 && sentiment === 'neutral') sentiment = 'negative';
    return { sentiment, category, severity, analyzer: this.name };
  }
}

export function createDefaultAnalyzer(): CommentAnalyzer {
  return new RuleBasedAnalyzer();
}

export const ALERT_SEVERITY_THRESHOLD = 4;

export function shouldAlert(severity: number): boolean {
  return severity >= ALERT_SEVERITY_THRESHOLD;
}
