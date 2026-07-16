import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Department } from '../types';

interface TemplateQuestion {
  id: string;
  code: string;
  text_ar: string;
  answer_type: string;
}

interface Template {
  id: string;
  name_ar: string;
  service_type: string;
  active: number;
  questions: TemplateQuestion[];
}

export default function SurveyStudio() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);

  const [templateId, setTemplateId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [channel, setChannel] = useState<'sms' | 'whatsapp' | 'phone'>('sms');
  const [phones, setPhones] = useState('');
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ templates: Template[] }>('/templates').then((res) => setTemplates(res.templates));
    api.get<{ departments: Department[] }>('/departments').then((res) => setDepartments(res.departments));
  }, []);

  const submitInvitations = async () => {
    const rows = phones
      .split('\n')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((phone) => ({ phone }));
    if (!templateId || !departmentId || rows.length === 0) {
      setResult('يرجى اختيار القالب والقسم وإدخال أرقام جوال.');
      return;
    }
    const res = await api.post<{ created: number }>('/invitations/bulk', { templateId, departmentId, channel, rows });
    setResult(`تم إنشاء ${res.created} دعوة استبيان بنجاح.`);
    setPhones('');
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-800">استوديو الاستبيانات</h2>
        <p className="text-sm text-slate-500">قوالب الاستبيانات حسب الخدمة، وإرسال دعوات بالجملة لمرضى الخروج اليوم</p>
      </div>

      <div className="rounded-2xl bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-sm font-semibold text-slate-700">إرسال دعوات استبيان بالجملة</h3>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
            <option value="">اختر القالب</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name_ar}
              </option>
            ))}
          </select>
          <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
            <option value="">اختر القسم</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name_ar}
              </option>
            ))}
          </select>
          <select value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
            <option value="sms">SMS</option>
            <option value="whatsapp">واتساب</option>
            <option value="phone">اتصال هاتفي</option>
          </select>
        </div>
        <textarea
          value={phones}
          onChange={(e) => setPhones(e.target.value)}
          rows={4}
          placeholder={'رقم جوال في كل سطر\n0501234567\n0559876543'}
          className="mt-3 w-full rounded-lg border border-slate-300 p-2 text-sm"
        />
        <button type="button" onClick={submitInvitations} className="mt-3 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">
          إرسال الدعوات
        </button>
        {result && <p className="mt-2 text-sm text-slate-600">{result}</p>}
      </div>

      <div className="space-y-3">
        {templates.map((t) => (
          <div key={t.id} className="rounded-2xl bg-white p-4 shadow-sm">
            <button type="button" onClick={() => setExpanded(expanded === t.id ? null : t.id)} className="flex w-full items-center justify-between text-right">
              <span className="font-semibold text-slate-800">{t.name_ar}</span>
              <span className="text-xs text-slate-400">{t.questions.length} سؤال</span>
            </button>
            {expanded === t.id && (
              <ul className="mt-3 space-y-1.5 border-t border-slate-100 pt-3">
                {t.questions.map((q) => (
                  <li key={q.id} className="flex justify-between text-xs text-slate-600">
                    <span>{q.text_ar}</span>
                    <span className="text-slate-400">{q.code}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
