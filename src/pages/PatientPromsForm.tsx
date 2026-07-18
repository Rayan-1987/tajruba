import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../api';

interface PromItem {
  code: string;
  textAr: string;
  textEn: string;
  scaleMax: number;
}

interface PromFormPayload {
  instrumentName: string;
  instrumentNameEn: string;
  items: PromItem[];
}

export default function PatientPromsForm() {
  const { token = '' } = useParams();
  const [form, setForm] = useState<PromFormPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api
      .get<PromFormPayload>(`/public/proms/${token}`)
      .then(setForm)
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 410) setError('تم إكمال هذا التقييم مسبقًا.');
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
    return (
      <div className="flex min-h-screen items-center justify-center bg-emerald-50 p-6" dir="rtl">
        <div className="rounded-2xl bg-white p-8 text-center shadow-sm">
          <div className="mb-3 text-4xl">✓</div>
          <h1 className="mb-2 text-xl font-bold text-emerald-700">شكرًا لك</h1>
          <p className="text-slate-600">تم استلام إجاباتك وستُستخدم لمتابعة حالتك الصحية.</p>
        </div>
      </div>
    );
  }

  if (!form) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100" dir="rtl">
        <p className="text-slate-500">جارِ التحميل...</p>
      </div>
    );
  }

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
    <div className="min-h-screen bg-slate-100 pb-24" dir="rtl">
      <header className="bg-white px-5 py-4 shadow-sm">
        <h1 className="text-lg font-bold text-slate-800">{form.instrumentName}</h1>
        <p className="text-sm text-slate-500">إجاباتك تساعدنا على متابعة تحسّن حالتك الصحية بمرور الوقت</p>
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
            <p className="mb-3 font-medium text-slate-800">{item.textAr}</p>
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
      </main>

      <div className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white p-4">
        <button
          type="button"
          disabled={submitting || answeredCount < form.items.length}
          onClick={submit}
          className="mx-auto block w-full max-w-xl rounded-xl bg-emerald-600 py-3 text-center font-semibold text-white transition disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {submitting ? 'جارِ الإرسال...' : 'إرسال التقييم'}
        </button>
      </div>
    </div>
  );
}
