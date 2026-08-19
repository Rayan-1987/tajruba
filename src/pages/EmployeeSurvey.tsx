import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { SurveyQuestionCard, type SurveyQuestion } from '../components/SurveyQuestionCard';

const STRINGS = {
  ar: {
    subtitle: 'إجابتك مجهولة تمامًا ولا يمكن ربطها بك',
    submit: 'إرسال',
    submitting: 'جارِ الإرسال...',
    loading: 'جارِ التحميل...',
    thanksTitle: 'شكرًا لك',
    thanksBody: 'وصلتنا إجابتك المجهولة وستُستخدم لتحسين بيئة العمل.',
    langToggle: 'English'
  },
  en: {
    subtitle: 'Your response is fully anonymous and cannot be traced back to you',
    submit: 'Submit',
    submitting: 'Submitting...',
    loading: 'Loading...',
    thanksTitle: 'Thank you',
    thanksBody: 'Your anonymous response was received and will be used to improve the work environment.',
    langToggle: 'العربية'
  }
} as const;

interface EmployeeSurveyDomain {
  id: string;
  nameAr: string;
  nameEn: string;
  questions: { id: string; textAr: string; textEn: string; answerType: SurveyQuestion['answer_type'] }[];
}

interface Branding {
  logoDataUri: string | null;
  primaryColor: string;
}

interface EmployeeSurveyPayload {
  instrumentNameAr: string;
  instrumentNameEn: string;
  defaultLanguage: 'ar' | 'en';
  branding?: Branding;
  domains: EmployeeSurveyDomain[];
}

export default function EmployeeSurvey() {
  const { token = '' } = useParams();
  const [survey, setSurvey] = useState<EmployeeSurveyPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [language, setLanguage] = useState<'ar' | 'en'>('ar');
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [textAnswers, setTextAnswers] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api
      .get<EmployeeSurveyPayload>(`/public/employee-survey/${token}`)
      .then((res) => {
        setSurvey(res);
        setLanguage(res.defaultLanguage ?? 'ar');
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 410) setError('تم إكمال هذه الاستبانة مسبقًا أو انتهت صلاحيتها.');
        else if (e instanceof ApiError && e.status === 404) setError('رابط الاستبانة غير صحيح.');
        else setError('تعذر تحميل الاستبانة، حاول مرة أخرى.');
      });
  }, [token]);

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

  const allQuestions = survey.domains.flatMap((d) => d.questions);
  // Open-ended questions are optional, matching the backend's submit validation.
  const requiredQuestions = allQuestions.filter((q) => q.answerType !== 'text');
  const answeredCount = requiredQuestions.filter((q) => answers[q.id] !== undefined).length;
  const t = STRINGS[language];

  const submit = async () => {
    setSubmitting(true);
    try {
      await api.post(`/public/employee-survey/${token}/submit`, {
        answers: [
          ...Object.entries(answers).map(([questionId, value]) => ({ questionId, value })),
          ...Object.entries(textAnswers)
            .filter(([, text]) => text.trim())
            .map(([questionId, text]) => ({ questionId, text: text.trim() }))
        ]
      });
      setSubmitted(true);
    } catch {
      setError('تعذر إرسال الاستبانة، حاول مرة أخرى.');
    } finally {
      setSubmitting(false);
    }
  };

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
              <h1 className="text-lg font-bold text-slate-800">{language === 'en' ? survey.instrumentNameEn : survey.instrumentNameAr}</h1>
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
          aria-valuemax={requiredQuestions.length}
          aria-valuenow={answeredCount}
          aria-label={language === 'en' ? 'Survey progress' : 'تقدم تعبئة الاستبانة'}
        >
          <div
            className={`h-full rounded-full transition-all ${accentColor ? '' : 'bg-emerald-500'}`}
            style={{ width: `${Math.min(100, (answeredCount / Math.max(1, requiredQuestions.length)) * 100)}%`, backgroundColor: accentColor }}
          />
        </div>
      </header>

      <main className="mx-auto max-w-xl space-y-6 px-4 py-5">
        {survey.domains.map((domain) => (
          <section key={domain.id} aria-labelledby={`domain-${domain.id}`}>
            <h2 id={`domain-${domain.id}`} className="mb-2 px-1 text-sm font-semibold text-slate-500">
              {language === 'en' ? domain.nameEn : domain.nameAr}
            </h2>
            <div className="space-y-3">
              {domain.questions.map((q) =>
                q.answerType === 'text' ? (
                  <div key={q.id} className="rounded-2xl bg-white p-4 shadow-sm">
                    <label htmlFor={`text-${q.id}`} className="mb-2 block font-medium text-slate-800">
                      {language === 'en' ? q.textEn : q.textAr}
                    </label>
                    <textarea
                      id={`text-${q.id}`}
                      value={textAnswers[q.id] ?? ''}
                      onChange={(e) => setTextAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                      rows={3}
                      className="w-full rounded-xl border border-slate-200 p-3 text-sm focus:border-emerald-400 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
                      placeholder={language === 'en' ? 'Optional' : 'اختياري'}
                    />
                  </div>
                ) : (
                  <SurveyQuestionCard
                    key={q.id}
                    question={{ id: q.id, code: q.id, text_ar: q.textAr, text_en: q.textEn, answer_type: q.answerType, depends_on_code: null }}
                    value={answers[q.id]}
                    language={language}
                    accentColor={accentColor}
                    onSelect={(value) => setAnswers((prev) => ({ ...prev, [q.id]: value }))}
                    onSelectWithClear={(value) => setAnswers((prev) => ({ ...prev, [q.id]: value }))}
                  />
                )
              )}
            </div>
          </section>
        ))}
      </main>

      <div className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white p-4">
        <button
          type="button"
          disabled={submitting || answeredCount < requiredQuestions.length}
          onClick={submit}
          style={!submitting && answeredCount >= requiredQuestions.length ? { backgroundColor: accentColor } : undefined}
          className={`mx-auto block w-full max-w-xl rounded-xl py-3 text-center font-semibold text-white transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800 disabled:cursor-not-allowed disabled:bg-slate-300 ${accentColor ? '' : 'bg-emerald-600'}`}
        >
          {submitting ? t.submitting : t.submit}
        </button>
      </div>
    </div>
  );
}
