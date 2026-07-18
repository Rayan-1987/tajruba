import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../AuthContext';
import type { Department } from '../types';

interface TemplateQuestion {
  id: string;
  code: string;
  text_ar: string;
  answer_type: 'likert5' | 'nps' | 'yesno' | 'text' | 'vas';
  depends_on_code: string | null;
}

interface Template {
  id: string;
  name_ar: string;
  service_type: string;
  active: number;
  questions: TemplateQuestion[];
}

export default function PhoneSurvey() {
  const { user } = useAuth();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [departmentId, setDepartmentId] = useState(user?.departmentId ?? '');
  const [patientPhone, setPatientPhone] = useState('');
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [comment, setComment] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.get<{ templates: Template[] }>('/templates').then((res) => setTemplates(res.templates));
    api.get<{ departments: Department[] }>('/departments').then((res) => setDepartments(res.departments));
  }, []);

  const template = templates.find((t) => t.id === templateId);

  const idByCode: Record<string, string> = {};
  for (const q of template?.questions ?? []) idByCode[q.code] = q.id;

  const isVisible = (q: TemplateQuestion): boolean => {
    if (!q.depends_on_code) return true;
    const gateId = idByCode[q.depends_on_code];
    return answers[gateId] === 1;
  };
  const visibleQuestions = (template?.questions ?? []).filter(isVisible);

  const resetForm = () => {
    setAnswers({});
    setComment('');
    setPatientPhone('');
  };

  const submit = async () => {
    if (!templateId || !departmentId || !patientPhone) {
      setResult('يرجى اختيار القالب والقسم وإدخال رقم جوال المريض.');
      return;
    }
    setSubmitting(true);
    try {
      const visibleIds = new Set(visibleQuestions.map((q) => q.id));
      await api.post('/phone-survey/submit', {
        templateId,
        departmentId,
        patientPhone,
        answers: Object.entries(answers)
          .filter(([questionId]) => visibleIds.has(questionId))
          .map(([questionId, value]) => ({ questionId, value })),
        comment: comment.trim() || undefined
      });
      setResult('تم تسجيل استبيان المريض بنجاح.');
      resetForm();
    } catch {
      setResult('تعذر إرسال الاستبيان، حاول مرة أخرى.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-800">استبيان هاتفي (بمساعدة موظف)</h2>
        <p className="text-sm text-slate-500">لتعبئة الاستبيان نيابة عن مريض تم الاتصال به هاتفيًا</p>
      </div>

      <div className="rounded-2xl bg-white p-4 shadow-sm">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <select
            value={departmentId}
            disabled={user?.role === 'DepartmentManager'}
            onChange={(e) => setDepartmentId(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-100"
          >
            <option value="">اختر القسم</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name_ar}
              </option>
            ))}
          </select>
          <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
            <option value="">اختر القالب</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name_ar}
              </option>
            ))}
          </select>
          <input
            value={patientPhone}
            onChange={(e) => setPatientPhone(e.target.value)}
            placeholder="رقم جوال المريض"
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </div>
      </div>

      {template && (
        <div className="space-y-3">
          {visibleQuestions.map((q) => (
            <div key={q.id} className="rounded-2xl bg-white p-4 shadow-sm">
              <p className="mb-3 font-medium text-slate-800">{q.text_ar}</p>
              {q.answer_type === 'yesno' && (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setAnswers((prev) => ({ ...prev, [q.id]: 1 }))}
                    className={`flex-1 rounded-lg py-2 text-sm font-semibold transition ${
                      answers[q.id] === 1 ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    نعم
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setAnswers((prev) => {
                        const next = { ...prev, [q.id]: 0 };
                        for (const other of template.questions) {
                          if (other.depends_on_code === q.code) delete next[other.id];
                        }
                        return next;
                      })
                    }
                    className={`flex-1 rounded-lg py-2 text-sm font-semibold transition ${
                      answers[q.id] === 0 ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    لا
                  </button>
                </div>
              )}
              {q.answer_type === 'likert5' && (
                <div className="flex gap-1">
                  {[1, 2, 3, 4, 5].map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setAnswers((prev) => ({ ...prev, [q.id]: value }))}
                      className={`flex-1 rounded-lg py-2 text-sm font-semibold transition ${
                        answers[q.id] === value ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                      }`}
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
                      className={`rounded-lg py-1.5 text-xs font-semibold transition ${
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
            <p className="mb-2 font-medium text-slate-800">ملاحظات المريض (اختياري)</p>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={3}
              className="w-full rounded-lg border border-slate-200 p-3 text-sm"
              placeholder="اكتب ما ذكره المريض..."
            />
          </div>

          <button
            type="button"
            disabled={submitting}
            onClick={submit}
            className="w-full rounded-xl bg-emerald-600 py-3 text-center font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-60"
          >
            {submitting ? 'جارِ الحفظ...' : 'حفظ استبيان المريض'}
          </button>
        </div>
      )}

      {result && <p className="text-sm text-slate-600">{result}</p>}
    </div>
  );
}
