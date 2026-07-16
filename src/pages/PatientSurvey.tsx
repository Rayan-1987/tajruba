import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../api';

interface SurveyQuestion {
  id: string;
  code: string;
  text_ar: string;
  text_en: string;
  answer_type: 'likert5' | 'nps' | 'yesno' | 'text' | 'vas';
}

interface SurveyPayload {
  templateName: string;
  templateNameEn: string;
  serviceType: string;
  questions: SurveyQuestion[];
}

const LIKERT_LABELS = ['غير راضٍ إطلاقًا', 'غير راضٍ', 'محايد', 'راضٍ', 'راضٍ جدًا'];

export default function PatientSurvey() {
  const { token = '' } = useParams();
  const [survey, setSurvey] = useState<SurveyPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [comment, setComment] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api
      .get<SurveyPayload>(`/public/surveys/${token}`)
      .then(setSurvey)
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 410) setError('تم إكمال هذا الاستبيان مسبقًا أو انتهت صلاحيته.');
        else if (e instanceof ApiError && e.status === 404) setError('رابط الاستبيان غير صحيح.');
        else setError('تعذر تحميل الاستبيان، حاول مرة أخرى.');
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
          <p className="text-slate-600">وصلتنا ملاحظاتك وسيتم استخدامها لتحسين الخدمة المقدمة لك.</p>
        </div>
      </div>
    );
  }

  if (!survey) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100" dir="rtl">
        <p className="text-slate-500">جارِ التحميل...</p>
      </div>
    );
  }

  const answeredCount = Object.keys(answers).length;

  const submit = async () => {
    setSubmitting(true);
    try {
      await api.post(`/public/surveys/${token}/submit`, {
        answers: Object.entries(answers).map(([questionId, value]) => ({ questionId, value })),
        comment: comment.trim() || undefined,
        language: 'ar'
      });
      setSubmitted(true);
    } catch {
      setError('تعذر إرسال الاستبيان، حاول مرة أخرى.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 pb-24" dir="rtl">
      <header className="bg-white px-5 py-4 shadow-sm">
        <h1 className="text-lg font-bold text-slate-800">{survey.templateName}</h1>
        <p className="text-sm text-slate-500">رأيك يساعدنا على تحسين تجربتك القادمة</p>
        <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-200">
          <div
            className="h-full rounded-full bg-emerald-500 transition-all"
            style={{ width: `${Math.min(100, (answeredCount / Math.max(1, survey.questions.length)) * 100)}%` }}
          />
        </div>
      </header>

      <main className="mx-auto max-w-xl space-y-4 px-4 py-5">
        {survey.questions.map((q) => (
          <div key={q.id} className="rounded-2xl bg-white p-4 shadow-sm">
            <p className="mb-3 font-medium text-slate-800">{q.text_ar}</p>
            {q.answer_type === 'likert5' && (
              <div className="flex justify-between gap-1">
                {[1, 2, 3, 4, 5].map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setAnswers((prev) => ({ ...prev, [q.id]: value }))}
                    className={`flex-1 rounded-xl py-3 text-sm font-semibold transition ${
                      answers[q.id] === value ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                    title={LIKERT_LABELS[value - 1]}
                  >
                    {value}
                  </button>
                ))}
              </div>
            )}
            {q.answer_type === 'nps' && (
              <div className="grid grid-cols-11 gap-1">
                {Array.from({ length: 11 }, (_, i) => i).map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setAnswers((prev) => ({ ...prev, [q.id]: value }))}
                    className={`rounded-lg py-2 text-xs font-semibold transition ${
                      answers[q.id] === value ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    {value}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}

        <div className="rounded-2xl bg-white p-4 shadow-sm">
          <p className="mb-2 font-medium text-slate-800">أي ملاحظات إضافية تود مشاركتها؟ (اختياري)</p>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={4}
            className="w-full rounded-xl border border-slate-200 p-3 text-sm focus:border-emerald-400 focus:outline-none"
            placeholder="اكتب ملاحظتك هنا..."
          />
        </div>
      </main>

      <div className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white p-4">
        <button
          type="button"
          disabled={submitting || answeredCount < survey.questions.length}
          onClick={submit}
          className="mx-auto block w-full max-w-xl rounded-xl bg-emerald-600 py-3 text-center font-semibold text-white transition disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {submitting ? 'جارِ الإرسال...' : 'إرسال التقييم'}
        </button>
      </div>
    </div>
  );
}
