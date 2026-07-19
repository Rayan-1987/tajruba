import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../api';

const STRINGS = {
  ar: {
    subtitle: 'إجاباتك تساعدنا على متابعة تحسّن حالتك الصحية بمرور الوقت',
    optOutPrompt: 'لا ترغب بمتابعة هذا البرنامج؟',
    optOutLink: 'إيقاف الرسائل',
    submit: 'إرسال التقييم',
    submitting: 'جارِ الإرسال...',
    loading: 'جارِ التحميل...',
    thanksTitle: 'شكرًا لك',
    thanksBody: 'تم استلام إجاباتك وستُستخدم لمتابعة حالتك الصحية.',
    langToggle: 'English'
  },
  en: {
    subtitle: 'Your answers help us track your recovery over time',
    optOutPrompt: 'Do not want to continue this program?',
    optOutLink: 'Stop messages',
    submit: 'Submit',
    submitting: 'Submitting...',
    loading: 'Loading...',
    thanksTitle: 'Thank you',
    thanksBody: 'Your answers were received and will be used to track your health progress.',
    langToggle: 'العربية'
  }
} as const;

interface PromItem {
  code: string;
  textAr: string;
  textEn: string;
  scaleMax: number;
}

interface PromFormPayload {
  instrumentName: string;
  instrumentNameEn: string;
  defaultLanguage: 'ar' | 'en';
  items: PromItem[];
}

export default function PatientPromsForm() {
  const { token = '' } = useParams();
  const [form, setForm] = useState<PromFormPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [language, setLanguage] = useState<'ar' | 'en'>('ar');
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api
      .get<PromFormPayload>(`/public/proms/${token}`)
      .then((res) => {
        setForm(res);
        setLanguage(res.defaultLanguage ?? 'ar');
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 410 && e.message === 'opted_out') setError('لقد أوقفت رسائل هذا البرنامج سابقًا.');
        else if (e instanceof ApiError && e.status === 410 && e.message === 'link_expired') setError('انتهت صلاحية رابط هذا التقييم.');
        else if (e instanceof ApiError && e.status === 410) setError('تم إكمال هذا التقييم مسبقًا.');
        else if (e instanceof ApiError && e.status === 409) setError('هذا التقييم يتطلب تعبئة ورقية بمساعدة الفريق الطبي، وليس عبر هذا الرابط.');
        else if (e instanceof ApiError && e.status === 404) setError('رابط التقييم غير صحيح.');
        else setError('تعذر تحميل التقييم، حاول مرة أخرى.');
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

  if (!form) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100" dir={language === 'en' ? 'ltr' : 'rtl'}>
        <p className="text-slate-500">{STRINGS[language].loading}</p>
      </div>
    );
  }

  const t = STRINGS[language];
  const answeredCount = form.items.filter((i) => answers[i.code] !== undefined).length;

  const submit = async () => {
    setSubmitting(true);
    try {
      await api.post(`/public/proms/${token}/submit`, {
        answers: Object.entries(answers).map(([code, value]) => ({ code, value }))
      });
      setSubmitted(true);
    } catch {
      setError('تعذر إرسال التقييم، حاول مرة أخرى.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 pb-24" dir={language === 'en' ? 'ltr' : 'rtl'}>
      <header className="bg-white px-5 py-4 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold text-slate-800">{language === 'en' ? form.instrumentNameEn : form.instrumentName}</h1>
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
            style={{ width: `${Math.min(100, (answeredCount / Math.max(1, form.items.length)) * 100)}%` }}
          />
        </div>
      </header>

      <main className="mx-auto max-w-xl space-y-4 px-4 py-5">
        {form.items.map((item) => (
          <div key={item.code} className="rounded-2xl bg-white p-4 shadow-sm">
            <p className="mb-3 font-medium text-slate-800">{language === 'en' ? item.textEn : item.textAr}</p>
            <div className="flex flex-wrap justify-between gap-1">
              {Array.from({ length: item.scaleMax + 1 }, (_, v) => v).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setAnswers((prev) => ({ ...prev, [item.code]: value }))}
                  className={`flex-1 rounded-xl py-3 text-sm font-semibold transition ${
                    answers[item.code] === value ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {value}
                </button>
              ))}
            </div>
          </div>
        ))}
        <p className="text-center text-xs text-slate-400">
          {t.optOutPrompt}{' '}
          <a href={`/p/${token}/opt-out`} className="font-semibold text-slate-500 underline">
            {t.optOutLink}
          </a>
        </p>
      </main>

      <div className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white p-4">
        <button
          type="button"
          disabled={submitting || answeredCount < form.items.length}
          onClick={submit}
          className="mx-auto block w-full max-w-xl rounded-xl bg-emerald-600 py-3 text-center font-semibold text-white transition disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {submitting ? t.submitting : t.submit}
        </button>
      </div>
    </div>
  );
}
