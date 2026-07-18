import { useEffect, useState } from 'react';
import { api } from '../api';
import { ROLE_LABELS_AR, SERVICE_LABELS_AR, type Department, type Role, type ServiceType } from '../types';

type AnswerType = 'likert5' | 'nps' | 'yesno' | 'text' | 'vas';

const ANSWER_TYPE_LABELS_AR: Record<AnswerType, string> = {
  likert5: 'ليكرت (1-5)',
  nps: 'NPS (0-10)',
  yesno: 'نعم/لا',
  text: 'نص حر',
  vas: 'مقياس تناظري (0-10)'
};

interface UserRow {
  id: string;
  email: string;
  role: Role;
  department_id: string | null;
  full_name: string;
  active: number;
}

interface Domain {
  id: string;
  code: string;
  name_ar: string;
  name_en: string;
  service_type: ServiceType;
  benchmark_top_box_percent: number;
  active: number;
}

interface QuestionRow {
  id: string;
  code: string;
  domain_id: string;
  text_ar: string;
  text_en: string;
  answer_type: AnswerType;
  service_type: ServiceType;
  requires_alert: number;
  active: number;
}

type Tab = 'departments' | 'users' | 'question-bank';

export default function Admin() {
  const [tab, setTab] = useState<Tab>('departments');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-800">الإدارة</h2>
        <p className="text-sm text-slate-500">إدارة الأقسام والمستخدمين وبنك الأسئلة لهذا المستشفى</p>
      </div>

      <div className="flex gap-1 border-b border-slate-200">
        {(
          [
            ['departments', 'الأقسام'],
            ['users', 'المستخدمون'],
            ['question-bank', 'بنك الأسئلة']
          ] as [Tab, string][]
        ).map(([value, label]) => (
          <button
            key={value}
            onClick={() => setTab(value)}
            className={`px-4 py-2 text-sm font-medium transition ${
              tab === value ? 'border-b-2 border-emerald-600 text-emerald-700' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'departments' && <DepartmentsTab />}
      {tab === 'users' && <UsersTab />}
      {tab === 'question-bank' && <QuestionBankTab />}
    </div>
  );
}

function DepartmentsTab() {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [nameAr, setNameAr] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [serviceType, setServiceType] = useState<ServiceType>('MP');
  const [editing, setEditing] = useState<Record<string, { nameAr: string; nameEn: string }>>({});

  const load = () => {
    api.get<{ departments: Department[] }>('/departments?includeInactive=1').then((res) => setDepartments(res.departments));
  };
  useEffect(load, []);

  const create = async () => {
    if (!nameAr || !nameEn) return;
    await api.post('/departments', { nameAr, nameEn, serviceType });
    setNameAr('');
    setNameEn('');
    load();
  };

  const startEdit = (d: Department) => setEditing((prev) => ({ ...prev, [d.id]: { nameAr: d.name_ar, nameEn: d.name_en } }));

  const saveEdit = async (id: string) => {
    const edit = editing[id];
    if (!edit) return;
    await api.patch(`/departments/${id}`, { nameAr: edit.nameAr, nameEn: edit.nameEn });
    setEditing((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    load();
  };

  const toggleActive = async (d: Department) => {
    if (d.active) {
      await api.delete(`/departments/${d.id}`);
    } else {
      await api.patch(`/departments/${d.id}`, { active: true });
    }
    load();
  };

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-sm font-semibold text-slate-700">إضافة قسم جديد</h3>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
          <input value={nameAr} onChange={(e) => setNameAr(e.target.value)} placeholder="الاسم بالعربية" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          <input value={nameEn} onChange={(e) => setNameEn(e.target.value)} placeholder="الاسم بالإنجليزية" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          <select value={serviceType} onChange={(e) => setServiceType(e.target.value as ServiceType)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
            {Object.entries(SERVICE_LABELS_AR).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <button type="button" onClick={create} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">
            إضافة
          </button>
        </div>
      </div>

      <div className="rounded-2xl bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-right text-xs text-slate-400">
              <th className="px-4 py-2 font-medium">الاسم</th>
              <th className="px-4 py-2 font-medium">الخدمة</th>
              <th className="px-4 py-2 font-medium">الحالة</th>
              <th className="px-4 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {departments.map((d) => (
              <tr key={d.id} className="border-b border-slate-50">
                <td className="px-4 py-2">
                  {editing[d.id] ? (
                    <div className="flex gap-2">
                      <input
                        value={editing[d.id].nameAr}
                        onChange={(e) => setEditing((prev) => ({ ...prev, [d.id]: { ...prev[d.id], nameAr: e.target.value } }))}
                        className="w-32 rounded border border-slate-300 px-2 py-1 text-xs"
                      />
                      <input
                        value={editing[d.id].nameEn}
                        onChange={(e) => setEditing((prev) => ({ ...prev, [d.id]: { ...prev[d.id], nameEn: e.target.value } }))}
                        className="w-32 rounded border border-slate-300 px-2 py-1 text-xs"
                      />
                    </div>
                  ) : (
                    <span className={d.active ? 'text-slate-700' : 'text-slate-400 line-through'}>{d.name_ar}</span>
                  )}
                </td>
                <td className="px-4 py-2 text-xs text-slate-500">{SERVICE_LABELS_AR[d.service_type]}</td>
                <td className="px-4 py-2 text-xs">{d.active ? '✅ فعّال' : '⏸️ موقوف'}</td>
                <td className="px-4 py-2 text-left">
                  <div className="flex justify-end gap-2">
                    {editing[d.id] ? (
                      <button onClick={() => saveEdit(d.id)} className="text-xs font-semibold text-emerald-600 hover:underline">
                        حفظ
                      </button>
                    ) : (
                      <button onClick={() => startEdit(d)} className="text-xs font-semibold text-slate-600 hover:underline">
                        تعديل
                      </button>
                    )}
                    <button onClick={() => toggleActive(d)} className="text-xs font-semibold text-red-600 hover:underline">
                      {d.active ? 'إيقاف' : 'تفعيل'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function UsersTab() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState<Role>('DepartmentManager');
  const [departmentId, setDepartmentId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    api.get<{ users: UserRow[] }>('/users').then((res) => setUsers(res.users));
    api.get<{ departments: Department[] }>('/departments').then((res) => setDepartments(res.departments));
  };
  useEffect(load, []);

  const create = async () => {
    setError(null);
    if (!email || !password || !fullName) return;
    if (role === 'DepartmentManager' && !departmentId) {
      setError('يجب اختيار القسم عند إنشاء مستخدم بصلاحية مدير قسم.');
      return;
    }
    try {
      await api.post('/users', { email, password, fullName, role, departmentId: role === 'DepartmentManager' ? departmentId : undefined });
      setEmail('');
      setPassword('');
      setFullName('');
      setDepartmentId('');
      load();
    } catch {
      setError('تعذر إنشاء المستخدم — تحقق من البريد الإلكتروني وكلمة المرور (8 أحرف على الأقل).');
    }
  };

  const toggleActive = async (u: UserRow) => {
    if (u.active) {
      await api.delete(`/users/${u.id}`);
    } else {
      await api.patch(`/users/${u.id}`, { active: true });
    }
    load();
  };

  const changeRole = async (u: UserRow, newRole: Role) => {
    await api.patch(`/users/${u.id}`, { role: newRole, departmentId: u.department_id });
    load();
  };

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-sm font-semibold text-slate-700">إضافة مستخدم جديد</h3>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="الاسم الكامل" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="البريد الإلكتروني" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="كلمة المرور (8 أحرف على الأقل)"
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <select value={role} onChange={(e) => setRole(e.target.value as Role)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
            {Object.entries(ROLE_LABELS_AR).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          {role === 'DepartmentManager' && (
            <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
              <option value="">اختر القسم</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name_ar}
                </option>
              ))}
            </select>
          )}
          <button type="button" onClick={create} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">
            إضافة
          </button>
        </div>
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      </div>

      <div className="rounded-2xl bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-right text-xs text-slate-400">
              <th className="px-4 py-2 font-medium">الاسم</th>
              <th className="px-4 py-2 font-medium">البريد الإلكتروني</th>
              <th className="px-4 py-2 font-medium">الصلاحية</th>
              <th className="px-4 py-2 font-medium">الحالة</th>
              <th className="px-4 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-b border-slate-50">
                <td className={`px-4 py-2 ${u.active ? 'text-slate-700' : 'text-slate-400 line-through'}`}>{u.full_name}</td>
                <td className="px-4 py-2 text-xs text-slate-500">{u.email}</td>
                <td className="px-4 py-2">
                  <select value={u.role} onChange={(e) => changeRole(u, e.target.value as Role)} className="rounded border border-slate-300 px-2 py-1 text-xs">
                    {Object.entries(ROLE_LABELS_AR).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-4 py-2 text-xs">{u.active ? '✅ فعّال' : '⏸️ موقوف'}</td>
                <td className="px-4 py-2 text-left">
                  <button onClick={() => toggleActive(u)} className="text-xs font-semibold text-red-600 hover:underline">
                    {u.active ? 'إيقاف' : 'تفعيل'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function QuestionBankTab() {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [questions, setQuestions] = useState<QuestionRow[]>([]);
  const [expandedService, setExpandedService] = useState<ServiceType | null>(null);

  const [domainCode, setDomainCode] = useState('');
  const [domainNameAr, setDomainNameAr] = useState('');
  const [domainNameEn, setDomainNameEn] = useState('');
  const [domainService, setDomainService] = useState<ServiceType>('MP');
  const [domainBenchmark, setDomainBenchmark] = useState(75);

  const [qCode, setQCode] = useState('');
  const [qDomainId, setQDomainId] = useState('');
  const [qTextAr, setQTextAr] = useState('');
  const [qTextEn, setQTextEn] = useState('');
  const [qType, setQType] = useState<AnswerType>('likert5');
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    api.get<{ domains: Domain[]; questions: QuestionRow[] }>('/question-bank?includeInactive=1').then((res) => {
      setDomains(res.domains);
      setQuestions(res.questions);
    });
  };
  useEffect(load, []);

  const createDomain = async () => {
    setError(null);
    if (!domainCode || !domainNameAr || !domainNameEn) return;
    try {
      await api.post('/question-bank/domains', {
        code: domainCode,
        nameAr: domainNameAr,
        nameEn: domainNameEn,
        serviceType: domainService,
        benchmarkTopBoxPercent: domainBenchmark
      });
      setDomainCode('');
      setDomainNameAr('');
      setDomainNameEn('');
      load();
    } catch {
      setError('تعذر إنشاء المحور — تحقق من عدم تكرار الرمز (code).');
    }
  };

  const toggleDomainActive = async (d: Domain) => {
    await api.patch(`/question-bank/domains/${d.id}`, { active: !d.active });
    load();
  };

  const createQuestion = async () => {
    setError(null);
    if (!qCode || !qDomainId || !qTextAr || !qTextEn) return;
    try {
      await api.post('/question-bank/questions', { code: qCode, domainId: qDomainId, textAr: qTextAr, textEn: qTextEn, type: qType });
      setQCode('');
      setQTextAr('');
      setQTextEn('');
      load();
    } catch {
      setError('تعذر إنشاء السؤال — تحقق من عدم تكرار الرمز (code).');
    }
  };

  const toggleQuestionActive = async (q: QuestionRow) => {
    await api.patch(`/question-bank/questions/${q.id}`, { active: !q.active });
    load();
  };

  const services = Object.keys(SERVICE_LABELS_AR) as ServiceType[];

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-sm font-semibold text-slate-700">إضافة محور (Domain) جديد</h3>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <input value={domainCode} onChange={(e) => setDomainCode(e.target.value)} placeholder="الرمز (مثال: ED_XYZ)" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          <input value={domainNameAr} onChange={(e) => setDomainNameAr(e.target.value)} placeholder="الاسم بالعربية" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          <input value={domainNameEn} onChange={(e) => setDomainNameEn(e.target.value)} placeholder="الاسم بالإنجليزية" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          <select value={domainService} onChange={(e) => setDomainService(e.target.value as ServiceType)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
            {services.map((s) => (
              <option key={s} value={s}>
                {SERVICE_LABELS_AR[s]}
              </option>
            ))}
          </select>
          <input
            type="number"
            min={0}
            max={100}
            value={domainBenchmark}
            onChange={(e) => setDomainBenchmark(Number(e.target.value))}
            placeholder="المعيار المرجعي Top Box %"
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <button type="button" onClick={createDomain} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">
            إضافة محور
          </button>
        </div>
      </div>

      <div className="rounded-2xl bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-sm font-semibold text-slate-700">إضافة سؤال جديد</h3>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <input value={qCode} onChange={(e) => setQCode(e.target.value)} placeholder="رمز السؤال" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          <select value={qDomainId} onChange={(e) => setQDomainId(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
            <option value="">اختر المحور</option>
            {domains.filter((d) => d.active).map((d) => (
              <option key={d.id} value={d.id}>
                {SERVICE_LABELS_AR[d.service_type]} — {d.name_ar}
              </option>
            ))}
          </select>
          <select value={qType} onChange={(e) => setQType(e.target.value as AnswerType)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
            {Object.entries(ANSWER_TYPE_LABELS_AR).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <input value={qTextAr} onChange={(e) => setQTextAr(e.target.value)} placeholder="نص السؤال بالعربية" className="rounded-lg border border-slate-300 px-3 py-2 text-sm md:col-span-2" />
          <input value={qTextEn} onChange={(e) => setQTextEn(e.target.value)} placeholder="نص السؤال بالإنجليزية" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          <button type="button" onClick={createQuestion} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">
            إضافة سؤال
          </button>
        </div>
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        <p className="mt-2 text-xs text-slate-400">يُضاف السؤال تلقائيًا إلى نهاية استبيان الخدمة المرتبطة بالمحور المختار.</p>
      </div>

      <div className="space-y-3">
        {services.map((service) => {
          const serviceDomains = domains.filter((d) => d.service_type === service);
          if (serviceDomains.length === 0) return null;
          return (
            <div key={service} className="rounded-2xl bg-white p-4 shadow-sm">
              <button
                type="button"
                onClick={() => setExpandedService(expandedService === service ? null : service)}
                className="flex w-full items-center justify-between text-right"
              >
                <span className="font-semibold text-slate-800">{SERVICE_LABELS_AR[service]}</span>
                <span className="text-xs text-slate-400">{serviceDomains.length} محور</span>
              </button>
              {expandedService === service && (
                <div className="mt-3 space-y-3 border-t border-slate-100 pt-3">
                  {serviceDomains.map((d) => (
                    <div key={d.id}>
                      <div className="mb-1 flex items-center justify-between">
                        <span className={`text-sm font-semibold ${d.active ? 'text-slate-700' : 'text-slate-400 line-through'}`}>
                          {d.name_ar} <span className="text-xs font-normal text-slate-400">({d.code}, معيار {d.benchmark_top_box_percent}%)</span>
                        </span>
                        <button onClick={() => toggleDomainActive(d)} className="text-xs font-semibold text-red-600 hover:underline">
                          {d.active ? 'إيقاف المحور' : 'تفعيل المحور'}
                        </button>
                      </div>
                      <ul className="space-y-1 ps-3">
                        {questions
                          .filter((q) => q.domain_id === d.id)
                          .map((q) => (
                            <li key={q.id} className="flex items-center justify-between text-xs">
                              <span className={q.active ? 'text-slate-600' : 'text-slate-400 line-through'}>
                                {q.text_ar} <span className="text-slate-400">({ANSWER_TYPE_LABELS_AR[q.answer_type]})</span>
                              </span>
                              <button onClick={() => toggleQuestionActive(q)} className="font-semibold text-red-600 hover:underline">
                                {q.active ? 'إيقاف' : 'تفعيل'}
                              </button>
                            </li>
                          ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
