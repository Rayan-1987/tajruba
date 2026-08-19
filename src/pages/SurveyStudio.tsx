import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
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

interface KioskLink {
  id: string;
  code: string;
  label: string | null;
  active: number;
  response_count: number;
  department_name_ar: string;
  template_name_ar: string;
}

export default function SurveyStudio() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);

  const [templateId, setTemplateId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [channel, setChannel] = useState<'sms' | 'whatsapp' | 'phone' | 'email'>('sms');
  const [phones, setPhones] = useState('');
  const [providerName, setProviderName] = useState('');
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
      .map((value) => (channel === 'email' ? { email: value } : { phone: value }));
    if (!templateId || !departmentId || rows.length === 0) {
      setResult(channel === 'email' ? 'يرجى اختيار القالب والقسم وإدخال عناوين بريد إلكتروني.' : 'يرجى اختيار القالب والقسم وإدخال أرقام جوال.');
      return;
    }
    const res = await api.post<{ created: number }>('/invitations/bulk', {
      templateId,
      departmentId,
      channel,
      rows,
      providerName: providerName.trim() || undefined
    });
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
            <option value="email">بريد إلكتروني</option>
          </select>
          <input
            value={providerName}
            onChange={(e) => setProviderName(e.target.value)}
            placeholder="مقدّم الخدمة / الطبيب المعالج (اختياري)"
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm md:col-span-3"
          />
        </div>
        <textarea
          value={phones}
          onChange={(e) => setPhones(e.target.value)}
          rows={4}
          placeholder={
            channel === 'email' ? 'بريد إلكتروني في كل سطر\npatient1@example.com\npatient2@example.com' : 'رقم جوال في كل سطر\n0501234567\n0559876543'
          }
          className="mt-3 w-full rounded-lg border border-slate-300 p-2 text-sm"
        />
        <button type="button" onClick={submitInvitations} className="mt-3 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">
          إرسال الدعوات
        </button>
        {result && <p className="mt-2 text-sm text-slate-600">{result}</p>}
      </div>

      <KioskLinksSection templates={templates} departments={departments} />

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

function KioskLinksSection({ templates, departments }: { templates: Template[]; departments: Department[] }) {
  const [links, setLinks] = useState<KioskLink[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [label, setLabel] = useState('');
  const [qrByCode, setQrByCode] = useState<Record<string, string>>({});
  const [expandedCode, setExpandedCode] = useState<string | null>(null);

  const load = () => {
    api.get<{ kioskLinks: KioskLink[] }>('/kiosk-links').then((res) => setLinks(res.kioskLinks));
  };
  useEffect(load, []);

  const kioskUrl = (code: string) => `${window.location.origin}/k/${code}`;

  const showQr = async (code: string) => {
    if (expandedCode === code) {
      setExpandedCode(null);
      return;
    }
    setExpandedCode(code);
    if (!qrByCode[code]) {
      const dataUrl = await QRCode.toDataURL(kioskUrl(code), { width: 220, margin: 1 });
      setQrByCode((prev) => ({ ...prev, [code]: dataUrl }));
    }
  };

  const create = async () => {
    if (!templateId || !departmentId) return;
    await api.post('/kiosk-links', { templateId, departmentId, label: label || undefined });
    setLabel('');
    load();
  };

  const toggleActive = async (link: KioskLink) => {
    if (link.active) {
      await api.delete(`/kiosk-links/${link.id}`);
    } else {
      await api.patch(`/kiosk-links/${link.id}`, { active: true });
    }
    load();
  };

  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm">
      <h3 className="mb-1 text-sm font-semibold text-slate-700">قناة QR / الأجهزة الثابتة (Kiosk)</h3>
      <p className="mb-3 text-xs text-slate-500">
        رابط قابل لإعادة الاستخدام دون حد أقصى — اطبعه كرمز QR في القسم أو اعرضه على جهاز لوحي، ويمكن لأي عدد من المرضى
        استخدامه بشكل مجهول، بلا حاجة لرقم جوال.
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
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
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="ملصق (اختياري، مثال: مدخل الطوارئ)" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        <button type="button" onClick={create} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">
          إنشاء رمز QR جديد
        </button>
      </div>

      {links.length > 0 && (
        <div className="mt-4 space-y-2 border-t border-slate-100 pt-4">
          {links.map((link) => (
            <div key={link.id} className="rounded-xl border border-slate-100 p-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className={`text-sm font-semibold ${link.active ? 'text-slate-700' : 'text-slate-400 line-through'}`}>
                    {link.label || `${link.department_name_ar} — ${link.template_name_ar}`}
                  </p>
                  <p className="text-xs text-slate-400">
                    {link.department_name_ar} · استُخدم {link.response_count} مرة · {link.active ? 'فعّال' : 'موقوف'}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => showQr(link.code)} className="text-xs font-semibold text-emerald-600 hover:underline">
                    {expandedCode === link.code ? 'إخفاء الرمز' : 'عرض رمز QR'}
                  </button>
                  <button type="button" onClick={() => toggleActive(link)} className="text-xs font-semibold text-red-600 hover:underline">
                    {link.active ? 'إيقاف' : 'تفعيل'}
                  </button>
                </div>
              </div>
              {expandedCode === link.code && (
                <div className="mt-3 flex flex-col items-center gap-2 border-t border-slate-100 pt-3">
                  {qrByCode[link.code] && <img src={qrByCode[link.code]} alt="QR" className="h-40 w-40" />}
                  <code className="break-all text-xs text-slate-500">{kioskUrl(link.code)}</code>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
