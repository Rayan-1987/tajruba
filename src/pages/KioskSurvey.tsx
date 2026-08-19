import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { SurveyQuestionCard, type SurveyQuestion } from '../components/SurveyQuestionCard';

const STRINGS = {
  ar: {
    subtitle: 'شاركنا رأيك عن زيارتك اليوم',
    commentLabel: 'أي ملاحظات إضافية تود مشاركتها؟ (اختياري)',
    commentPlaceholder: 'اكتب ملاحظتك هنا...',
    submit: 'إرسال التقييم',
    submitting: 'جارِ الإرسال...',
    loading: 'جارِ التحميل...',
    thanksTitle: 'شكرًا لك',
    thanksBody: 'وصلتنا ملاحظاتك وسيتم استخدامها لتحسين الخدمة المقدمة.',
    resetNotice: (seconds: number) => `سيعود الجهاز جاهزًا للمريض التالي خلال ${seconds} ثانية...`,
    langToggle: 'English'
  },
  en: {
    subtitle: "Share your feedback about today's visit",
    commentLabel: 'Any additional feedback you would like to share? (optional)',
    commentPlaceholder: 'Write your comment here...',
    submit: 'Submit',
    submitting: 'Submitting...',
    loading: 'Loading...',
    thanksTitle: 'Thank you',
    thanksBody: 'Your feedback was received and will be used to improve the service.',
    resetNotice: (seconds: number) => `Ready for the next patient in ${seconds}s...`,
    langToggle: 'العربية'
  }
} as const;

interface Branding {
  logoDataUri: string | null;
  primaryColor: string;
}

interface SurveyPayload {
  templateName: string;
  templateNameEn: string;
  serviceType: string;
  defaultLanguage: 'ar' | 'en';
  branding?: Branding;
  questions: SurveyQuestion[];
}

const RESET_AFTER_SECONDS = 8;

export default function KioskSurvey() {
  const { code = '' } = useParams();
  const [survey, setSurvey] = useState<SurveyPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [language, setLanguage] = useState<'ar' | 'en'>('ar');
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [comment, setComment] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [countdown, setCountdown] = useState(RESET_AFTER_SECONDS);

  const load = useCallback(() => {
    setError(null);
    setSurvey(null);
    api
      .get<SurveyPayload>(`/public/kiosk/${code}`)
      .then((res) => {
        setSurvey(res);
        setLanguage(res.defaultLanguage ?? 'ar');
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 404) setError('رمز الجهاز غير صحيح أو تم إيقافه.');
        else setError('تعذر تحميل الاستبيان، حاول مرة أخرى.');
      });
  }, [code]);

  useEffect(load, [load]);

  // Kiosk devices run unattended, so after a submission we reset to a blank survey for the
  // next patient automatically rather than showing a dead-end "thank you" screen forever.
  useEffect(() => {
    if (!submitted) return;
    setCountdown(RESET_AFTER_SECONDS);
    const interval = setInterval(() => setCountdown((prev) => prev - 1), 1000);
    const timeout = setTimeout(() => {
      setSubmitted(false);
      setAnswers({});
      setComment('');
      load();
    }, RESET_AFTER_SECONDS * 1000);
    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [submitted, load]);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100 p-6" dir="rtl">
        <div className="rounded-2xl bg-white p-8 text-center shadow-sm">
          <p className="text-lg text-slate-700">{error}</p>
        </div>
      </div>
    );
  }

  if (submitted) {
    const t = STRINGS[language];
    return (
      <div className="flex min-h-screen items-center justify-center bg-emerald-50 p-6" dir={language === 'en' ? 'ltr' : 'rtl'}>
        <div className="rounded-2xl bg-white p-8 text-center shadow-sm">
          <div className="mb-3 text-4xl">✓</div>
          <h1 className="mb-2 text-xl font-bold text-emerald-700">{t.thanksTitle}</h1>
          <p className="text-slate-600">{t.thanksBody}</p>
          <p className="mt-4 text-xs text-slate-400">{t.resetNotice(countdown)}</p>
        </div>
      </div>
    );
  }

  if (!survey) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100" dir={language === 'en' ? 'ltr' : 'rtl'}>
        <p className="text-slate-500">{STRINGS[language].loading}</p>
      </div>
    );
  }

  const idByCode: Record<string, string> = {};
  for (const q of survey.questions) idByCode[q.code] = q.id;

  const isVisible = (q: SurveyQuestion): boolean => {
    if (!q.depends_on_code) return true;
    const gateId = idByCode[q.depends_on_code];
    return answers[gateId] === 1;
  };

  const visibleQuestions = survey.questions.filter(isVisible);
  const answeredCount = visibleQuestions.filter((q) => answers[q.id] !== undefined).length;

  const submit = async () => {
    setSubmitting(true);
    try {
      const visibleIds = new Set(visibleQuestions.map((q) => q.id));
      await api.post(`/public/kiosk/${code}/submit`, {
        answers: Object.entries(answers)
          .filter(([questionId]) => visibleIds.has(questionId))
          .map(([questionId, value]) => ({ questionId, value })),
        comment: comment.trim() || undefined,
        language
      });
      setSubmitted(true);
    } catch {
      setError('تعذر إرسال الاستبيان، حاول مرة أخرى.');
    } finally {
      setSubmitting(false);
    }
  };

  const t = STRINGS[language];
  const accentColor = survey.branding?.primaryColor;

  return (
    <div className="min-h-screen bg-slate-100 pb-24" dir={language === 'en' ? 'ltr' : 'rtl'} lang={language}>
      <header className="bg-white px-5 py-4 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            {survey.branding?.logoDataUri && (
              <img src={survey.branding.logoDataUri} alt="" className="h-10 w-10 shrink-0 rounded-lg object-contain" />
            )}
            <div>
              <h1 className="text-lg font-bold text-slate-800">{language === 'en' ? survey.templateNameEn : survey.templateName}</h1>
              <p className="text-sm text-slate-500">{t.subtitle}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setLanguage((l) => (l === 'ar' ? 'en' : 'ar'))}
            className="shrink-0 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600"
          >
            {t.langToggle}
          </button>
        </div>
        <div
          className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-200"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={visibleQuestions.length}
          aria-valuenow={answeredCount}
          aria-label={language === 'en' ? 'Survey progress' : 'تقدم تعبئة الاستبيان'}
        >
          <div
            className={`h-full rounded-full transition-all ${accentColor ? '' : 'bg-emerald-500'}`}
            style={{ width: `${Math.min(100, (answeredCount / Math.max(1, visibleQuestions.length)) * 100)}%`, backgroundColor: accentColor }}
          />
        </div>
      </header>

      <main className="mx-auto max-w-xl space-y-4 px-4 py-5">
        {visibleQuestions.map((q) => (
          <SurveyQuestionCard
            key={q.id}
            question={q}
            value={answers[q.id]}
            language={language}
            accentColor={accentColor}
            onSelect={(value) => setAnswers((prev) => ({ ...prev, [q.id]: value }))}
            onSelectWithClear={(value) =>
              setAnswers((prev) => {
                const next = { ...prev, [q.id]: value };
                for (const other of survey.questions) {
                  if (other.depends_on_code === q.code) delete next[other.id];
                }
                return next;
              })
            }
          />
        ))}

        <div className="rounded-2xl bg-white p-4 shadow-sm">
          <label htmlFor="kiosk-comment" className="mb-2 block font-medium text-slate-800">
            {t.commentLabel}
          </label>
          <textarea
            id="kiosk-comment"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={4}
            className="w-full rounded-xl border border-slate-200 p-3 text-sm focus:border-emerald-400 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
            placeholder={t.commentPlaceholder}
          />
        </div>
      </main>

      <div className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white p-4">
        <button
          type="button"
          disabled={submitting || answeredCount < visibleQuestions.length}
          onClick={submit}
          style={!submitting && answeredCount >= visibleQuestions.length ? { backgroundColor: accentColor } : undefined}
          className={`mx-auto block w-full max-w-xl rounded-xl py-3 text-center font-semibold text-white transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800 disabled:cursor-not-allowed disabled:bg-slate-300 ${accentColor ? '' : 'bg-emerald-600'}`}
        >
          {submitting ? t.submitting : t.submit}
        </button>
      </div>
    </div>
  );
}
