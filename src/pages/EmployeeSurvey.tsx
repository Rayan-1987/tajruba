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

interface EmployeeSurveyPayload {
  instrumentNameAr: string;
  instrumentNameEn: string;
  defaultLanguage: 'ar' | 'en';
  domains: EmployeeSurveyDomain[];
}

export default function EmployeeSurvey() {
  const { token = '' } = useParams();
  const [survey, setSurvey] = useState<EmployeeSurveyPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [language, setLanguage] = useState<'ar' | 'en'>('ar');
  const [answers, setAnswers] = useState<Record<string, number>>({});
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
  const answeredCount = allQuestions.filter((q) => answers[q.id] !== undefined).length;
  const t = STRINGS[language];

  const submit = async () => {
    setSubmitting(true);
    try {
      await api.post(`/public/employee-survey/${token}/submit`, {
        answers: Object.entries(answers).map(([questionId, value]) => ({ questionId, value }))
      });
      setSubmitted(true);
    } catch {
      setError('تعذر إرسال الاستبانة، حاول مرة أخرى.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 pb-24" dir={language === 'en' ? 'ltr' : 'rtl'}>
      <header className="bg-white px-5 py-4 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold text-slate-800">{language === 'en' ? survey.instrumentNameEn : survey.instrumentNameAr}</h1>
            <p className="text-sm text-slate-500">{t.subtitle}</p>
          </div>
          <button
            type="button"
            onClick={() => setLanguage((l) => (l === 'ar' ? 'en' : 'ar'))}
            className="shrink-0 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
          >
            {t.langToggle}
          </button>
        </div>
        <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-200">
          <div
            className="h-full rounded-full bg-emerald-500 transition-all"
            style={{ width: `${Math.min(100, (answeredCount / Math.max(1, allQuestions.length)) * 100)}%` }}
          />
        </div>
      </header>

      <main className="mx-auto max-w-xl space-y-6 px-4 py-5">
        {survey.domains.map((domain) => (
          <section key={domain.id}>
            <h2 className="mb-2 px-1 text-sm font-semibold text-slate-500">{language === 'en' ? domain.nameEn : domain.nameAr}</h2>
            <div className="space-y-3">
              {domain.questions.map((q) => (
                <SurveyQuestionCard
                  key={q.id}
                  question={{ id: q.id, code: q.id, text_ar: q.textAr, text_en: q.textEn, answer_type: q.answerType, depends_on_code: null }}
                  value={answers[q.id]}
                  language={language}
                  onSelect={(value) => setAnswers((prev) => ({ ...prev, [q.id]: value }))}
                  onSelectWithClear={(value) => setAnswers((prev) => ({ ...prev, [q.id]: value }))}
                />
              ))}
            </div>
          </section>
        ))}
      </main>

      <div className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white p-4">
        <button
          type="button"
          disabled={submitting || answeredCount < allQuestions.length}
          onClick={submit}
          className="mx-auto block w-full max-w-xl rounded-xl bg-emerald-600 py-3 text-center font-semibold text-white transition disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {submitting ? t.submitting : t.submit}
        </button>
      </div>
    </div>
  );
}
