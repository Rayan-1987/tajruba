import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { SurveyQuestionCard, type SurveyQuestion } from '../components/SurveyQuestionCard';

interface SurveyPayload {
  templateName: string;
  templateNameEn: string;
  serviceType: string;
  questions: SurveyQuestion[];
}

export default function PatientSurvey() {
  const { token = '' } = useParams();
  const [survey, setSurvey] = useState<SurveyPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [comment, setComment] = useState('');
  const [contactOptIn, setContactOptIn] = useState(false);
  const [contactPhone, setContactPhone] = useState('');
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
      const optIn = Boolean(comment.trim()) && contactOptIn && Boolean(contactPhone.trim());
      await api.post(`/public/surveys/${token}/submit`, {
        answers: Object.entries(answers)
          .filter(([questionId]) => visibleIds.has(questionId))
          .map(([questionId, value]) => ({ questionId, value })),
        comment: comment.trim() || undefined,
        language: 'ar',
        contactOptIn: optIn || undefined,
        contactPhone: optIn ? contactPhone.trim() : undefined
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
            style={{ width: `${Math.min(100, (answeredCount / Math.max(1, visibleQuestions.length)) * 100)}%` }}
          />
        </div>
      </header>

      <main className="mx-auto max-w-xl space-y-4 px-4 py-5">
        {visibleQuestions.map((q) => (
          <SurveyQuestionCard
            key={q.id}
            question={q}
            value={answers[q.id]}
            onSelect={(value) => setAnswers((prev) => ({ ...prev, [q.id]: value }))}
            onSelectWithClear={(value) =>
              setAnswers((prev) => {
                const next = { ...prev, [q.id]: value };
                // Clear any follow-up answers that depended on this gate being "yes".
                for (const other of survey.questions) {
                  if (other.depends_on_code === q.code) delete next[other.id];
                }
                return next;
              })
            }
          />
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
          {comment.trim() && (
            <div className="mt-3 border-t border-slate-100 pt-3">
              <label className="flex items-start gap-2 text-xs text-slate-600">
                <input type="checkbox" checked={contactOptIn} onChange={(e) => setContactOptIn(e.target.checked)} className="mt-0.5" />
                <span>أوافق على أن يتواصل معي المستشفى بخصوص هذه الملاحظة فقط لإشعاري عند معالجتها (لن يُنشأ لي حساب دائم).</span>
              </label>
              {contactOptIn && (
                <input
                  value={contactPhone}
                  onChange={(e) => setContactPhone(e.target.value)}
                  placeholder="رقم الجوال للتواصل"
                  className="mt-2 w-full rounded-xl border border-slate-200 p-2.5 text-sm focus:border-emerald-400 focus:outline-none"
                />
              )}
            </div>
          )}
        </div>
      </main>

      <div className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white p-4">
        <button
          type="button"
          disabled={submitting || answeredCount < visibleQuestions.length}
          onClick={submit}
          className="mx-auto block w-full max-w-xl rounded-xl bg-emerald-600 py-3 text-center font-semibold text-white transition disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {submitting ? 'جارِ الإرسال...' : 'إرسال التقييم'}
        </button>
      </div>
    </div>
  );
}
