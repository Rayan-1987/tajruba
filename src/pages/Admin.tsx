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
  is_custom: number;
  cahps_item: number;
}

type Tab = 'departments' | 'users' | 'question-bank' | 'proms';

export default function Admin() {
  const [tab, setTab] = useState<Tab>('departments');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-800">الإدارة</h2>
        <p className="text-sm text-slate-500">إدارة الأقسام والمستخدمين وبنك الأسئلة ومقاييس PROMs لهذا المستشفى</p>
      </div>

      <div className="flex gap-1 border-b border-slate-200">
        {(
          [
            ['departments', 'الأقسام'],
            ['users', 'المستخدمون'],
            ['question-bank', 'بنك الأسئلة'],
            ['proms', 'مقاييس PROMs']
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
      {tab === 'proms' && <PromsConfigTab />}
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

  // Changing TO DepartmentManager always needs an explicit department — reusing the user's old
  // department_id (usually null, since most roles never had one) would silently create a
  // DepartmentManager scoped to no department, which bypasses department-based access control
  // entirely instead of restricting it. So that one transition is held back until a department
  // is chosen; every other role change applies immediately, same as before.
  const [pendingRoleChange, setPendingRoleChange] = useState<Record<string, string>>({});
  const [roleChangeError, setRoleChangeError] = useState<string | null>(null);

  const selectRole = (u: UserRow, newRole: Role) => {
    setRoleChangeError(null);
    if (newRole === 'DepartmentManager') {
      setPendingRoleChange((prev) => ({ ...prev, [u.id]: u.department_id ?? '' }));
      return;
    }
    setPendingRoleChange((prev) => {
      const next = { ...prev };
      delete next[u.id];
      return next;
    });
    api.patch(`/users/${u.id}`, { role: newRole }).then(load);
  };

  const confirmDepartmentManagerChange = async (u: UserRow) => {
    const departmentId = pendingRoleChange[u.id];
    if (!departmentId) {
      setRoleChangeError('يجب اختيار القسم عند تحويل المستخدم إلى مدير قسم.');
      return;
    }
    setRoleChangeError(null);
    await api.patch(`/users/${u.id}`, { role: 'DepartmentManager', departmentId });
    setPendingRoleChange((prev) => {
      const next = { ...prev };
      delete next[u.id];
      return next;
    });
    load();
  };

  const [passwordDraft, setPasswordDraft] = useState<Record<string, string>>({});
  const [passwordResultByUser, setPasswordResultByUser] = useState<Record<string, string>>({});

  const setUserPassword = async (u: UserRow) => {
    const newPassword = passwordDraft[u.id];
    if (!newPassword) return;
    try {
      await api.patch(`/users/${u.id}`, { password: newPassword });
      setPasswordDraft((prev) => ({ ...prev, [u.id]: '' }));
      setPasswordResultByUser((prev) => ({ ...prev, [u.id]: 'تم تعيين كلمة المرور — أُنهيت كل جلسات دخول هذا المستخدم.' }));
    } catch {
      setPasswordResultByUser((prev) => ({ ...prev, [u.id]: 'تعذر تعيين كلمة المرور (٨ أحرف على الأقل).' }));
    }
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

      {roleChangeError && <p className="text-xs text-red-600">{roleChangeError}</p>}

      <div className="rounded-2xl bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-right text-xs text-slate-400">
              <th className="px-4 py-2 font-medium">الاسم</th>
              <th className="px-4 py-2 font-medium">البريد الإلكتروني</th>
              <th className="px-4 py-2 font-medium">الصلاحية</th>
              <th className="px-4 py-2 font-medium">الحالة</th>
              <th className="px-4 py-2 font-medium">كلمة المرور</th>
              <th className="px-4 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-b border-slate-50 align-top">
                <td className={`px-4 py-2 ${u.active ? 'text-slate-700' : 'text-slate-400 line-through'}`}>{u.full_name}</td>
                <td className="px-4 py-2 text-xs text-slate-500">{u.email}</td>
                <td className="px-4 py-2">
                  <select
                    value={pendingRoleChange[u.id] !== undefined ? 'DepartmentManager' : u.role}
                    onChange={(e) => selectRole(u, e.target.value as Role)}
                    className="rounded border border-slate-300 px-2 py-1 text-xs"
                  >
                    {Object.entries(ROLE_LABELS_AR).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  {pendingRoleChange[u.id] !== undefined && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <select
                        value={pendingRoleChange[u.id]}
                        onChange={(e) => setPendingRoleChange((prev) => ({ ...prev, [u.id]: e.target.value }))}
                        className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs"
                      >
                        <option value="">اختر القسم</option>
                        {departments.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name_ar}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => confirmDepartmentManagerChange(u)}
                        className="rounded bg-emerald-600 px-2 py-1 text-xs font-semibold text-white hover:bg-emerald-700"
                      >
                        تأكيد
                      </button>
                    </div>
                  )}
                </td>
                <td className="px-4 py-2 text-xs">{u.active ? '✅ فعّال' : '⏸️ موقوف'}</td>
                <td className="px-4 py-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <input
                      type="password"
                      value={passwordDraft[u.id] ?? ''}
                      onChange={(e) => setPasswordDraft((prev) => ({ ...prev, [u.id]: e.target.value }))}
                      placeholder="كلمة مرور جديدة"
                      className="w-32 rounded border border-slate-300 px-2 py-1 text-xs"
                    />
                    <button
                      onClick={() => setUserPassword(u)}
                      className="rounded border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                    >
                      تعيين
                    </button>
                  </div>
                  {passwordResultByUser[u.id] && <p className="mt-1 max-w-[10rem] text-[10px] text-slate-500">{passwordResultByUser[u.id]}</p>}
                </td>
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
  const [qIsCustom, setQIsCustom] = useState(true);
  const [qCahpsItem, setQCahpsItem] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editingDomain, setEditingDomain] = useState<Record<string, { nameAr: string; nameEn: string; benchmark: number }>>({});
  const [editingQuestion, setEditingQuestion] = useState<Record<string, { textAr: string; textEn: string }>>({});

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

  const startEditDomain = (d: Domain) =>
    setEditingDomain((prev) => ({ ...prev, [d.id]: { nameAr: d.name_ar, nameEn: d.name_en, benchmark: d.benchmark_top_box_percent } }));

  const saveEditDomain = async (id: string) => {
    const edit = editingDomain[id];
    if (!edit) return;
    await api.patch(`/question-bank/domains/${id}`, { nameAr: edit.nameAr, nameEn: edit.nameEn, benchmarkTopBoxPercent: edit.benchmark });
    setEditingDomain((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    load();
  };

  const startEditQuestion = (q: QuestionRow) =>
    setEditingQuestion((prev) => ({ ...prev, [q.id]: { textAr: q.text_ar, textEn: q.text_en } }));

  const saveEditQuestion = async (id: string) => {
    const edit = editingQuestion[id];
    if (!edit) return;
    await api.patch(`/question-bank/questions/${id}`, { textAr: edit.textAr, textEn: edit.textEn });
    setEditingQuestion((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    load();
  };

  const createQuestion = async () => {
    setError(null);
    if (!qCode || !qDomainId || !qTextAr || !qTextEn) return;
    try {
      await api.post('/question-bank/questions', {
        code: qCode,
        domainId: qDomainId,
        textAr: qTextAr,
        textEn: qTextEn,
        type: qType,
        isCustom: qIsCustom,
        cahpsItem: qCahpsItem
      });
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

  const toggleQuestionCustom = async (q: QuestionRow) => {
    await api.patch(`/question-bank/questions/${q.id}`, { isCustom: !q.is_custom });
    load();
  };

  const toggleQuestionCahps = async (q: QuestionRow) => {
    await api.patch(`/question-bank/questions/${q.id}`, { cahpsItem: !q.cahps_item });
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
          <label className="flex items-center gap-2 text-xs text-slate-600">
            <input type="checkbox" checked={qIsCustom} onChange={(e) => setQIsCustom(e.target.checked)} />
            سؤال مخصص (†) وليس من البنك المعياري
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-600">
            <input type="checkbox" checked={qCahpsItem} onChange={(e) => setQCahpsItem(e.target.checked)} />
            عنصر CAHPS (يظهر له Top Box في التقارير)
          </label>
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
                      <div className="mb-1 flex items-center justify-between gap-2">
                        {editingDomain[d.id] ? (
                          <div className="flex flex-1 flex-wrap gap-2">
                            <input
                              value={editingDomain[d.id].nameAr}
                              onChange={(e) => setEditingDomain((prev) => ({ ...prev, [d.id]: { ...prev[d.id], nameAr: e.target.value } }))}
                              className="w-32 rounded border border-slate-300 px-2 py-1 text-xs"
                              placeholder="الاسم بالعربية"
                            />
                            <input
                              value={editingDomain[d.id].nameEn}
                              onChange={(e) => setEditingDomain((prev) => ({ ...prev, [d.id]: { ...prev[d.id], nameEn: e.target.value } }))}
                              className="w-32 rounded border border-slate-300 px-2 py-1 text-xs"
                              placeholder="الاسم بالإنجليزية"
                            />
                            <input
                              type="number"
                              min={0}
                              max={100}
                              value={editingDomain[d.id].benchmark}
                              onChange={(e) =>
                                setEditingDomain((prev) => ({ ...prev, [d.id]: { ...prev[d.id], benchmark: Number(e.target.value) } }))
                              }
                              className="w-20 rounded border border-slate-300 px-2 py-1 text-xs"
                              placeholder="المعيار %"
                            />
                          </div>
                        ) : (
                          <span className={`text-sm font-semibold ${d.active ? 'text-slate-700' : 'text-slate-400 line-through'}`}>
                            {d.name_ar} <span className="text-xs font-normal text-slate-400">({d.code}, معيار {d.benchmark_top_box_percent}%)</span>
                          </span>
                        )}
                        <div className="flex shrink-0 gap-2">
                          {editingDomain[d.id] ? (
                            <button onClick={() => saveEditDomain(d.id)} className="text-xs font-semibold text-emerald-600 hover:underline">
                              حفظ
                            </button>
                          ) : (
                            <button onClick={() => startEditDomain(d)} className="text-xs font-semibold text-slate-600 hover:underline">
                              تعديل
                            </button>
                          )}
                          <button onClick={() => toggleDomainActive(d)} className="text-xs font-semibold text-red-600 hover:underline">
                            {d.active ? 'إيقاف المحور' : 'تفعيل المحور'}
                          </button>
                        </div>
                      </div>
                      <ul className="space-y-1 ps-3">
                        {questions
                          .filter((q) => q.domain_id === d.id)
                          .map((q) => (
                            <li key={q.id} className="flex items-center justify-between gap-2 text-xs">
                              {editingQuestion[q.id] ? (
                                <div className="flex flex-1 flex-wrap gap-2">
                                  <input
                                    value={editingQuestion[q.id].textAr}
                                    onChange={(e) =>
                                      setEditingQuestion((prev) => ({ ...prev, [q.id]: { ...prev[q.id], textAr: e.target.value } }))
                                    }
                                    className="min-w-[10rem] flex-1 rounded border border-slate-300 px-2 py-1 text-xs"
                                    placeholder="نص السؤال بالعربية"
                                  />
                                  <input
                                    value={editingQuestion[q.id].textEn}
                                    onChange={(e) =>
                                      setEditingQuestion((prev) => ({ ...prev, [q.id]: { ...prev[q.id], textEn: e.target.value } }))
                                    }
                                    className="min-w-[10rem] flex-1 rounded border border-slate-300 px-2 py-1 text-xs"
                                    placeholder="نص السؤال بالإنجليزية"
                                  />
                                </div>
                              ) : (
                                <span className={q.active ? 'text-slate-600' : 'text-slate-400 line-through'}>
                                  {q.text_ar}
                                  {q.is_custom === 1 && <span title="سؤال مخصص، غير معياري">†</span>}{' '}
                                  <span className="text-slate-400">({ANSWER_TYPE_LABELS_AR[q.answer_type]})</span>
                                  {q.cahps_item === 1 && (
                                    <span className="ms-1 rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700">
                                      CAHPS
                                    </span>
                                  )}
                                </span>
                              )}
                              <div className="flex shrink-0 gap-2">
                                {editingQuestion[q.id] ? (
                                  <button onClick={() => saveEditQuestion(q.id)} className="font-semibold text-emerald-600 hover:underline">
                                    حفظ
                                  </button>
                                ) : (
                                  <button onClick={() => startEditQuestion(q)} className="font-semibold text-slate-600 hover:underline">
                                    تعديل
                                  </button>
                                )}
                                <button onClick={() => toggleQuestionCustom(q)} className="font-semibold text-slate-600 hover:underline">
                                  {q.is_custom ? 'اعتباره معياريًا' : 'اعتباره مخصصًا (†)'}
                                </button>
                                <button onClick={() => toggleQuestionCahps(q)} className="font-semibold text-slate-600 hover:underline">
                                  {q.cahps_item ? 'إزالة CAHPS' : 'وسمه CAHPS'}
                                </button>
                                <button onClick={() => toggleQuestionActive(q)} className="font-semibold text-red-600 hover:underline">
                                  {q.active ? 'إيقاف' : 'تفعيل'}
                                </button>
                              </div>
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

interface InstrumentItem {
  id: string;
  code: string;
  text_ar: string;
  text_en: string;
  reverse_scored: number;
  scale_max: number;
  sort_order: number;
}

interface Instrument {
  id: string;
  code: string;
  name_ar: string;
  name_en: string;
  license_status: 'free' | 'licensed_required';
  description_ar: string;
  higher_is_better: number;
  mcid_threshold: number;
  active: number;
  items: InstrumentItem[];
}

interface Timepoint {
  id: string;
  code: string;
  name_ar: string;
  offset_days: number;
  window_days: number;
  instrument_ids_json: string;
}

interface Pathway {
  id: string;
  code: string;
  name_ar: string;
  name_en: string;
  active: number;
  timepoints: Timepoint[];
}

function PromsConfigTab() {
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [pathways, setPathways] = useState<Pathway[]>([]);
  const [expandedInstrument, setExpandedInstrument] = useState<string | null>(null);
  const [expandedPathway, setExpandedPathway] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    api.get<{ instruments: Instrument[] }>('/proms/instruments?includeInactive=1').then((res) => setInstruments(res.instruments));
    api.get<{ pathways: Pathway[] }>('/proms/pathways?includeInactive=1').then((res) => setPathways(res.pathways));
  };
  useEffect(load, []);

  const toggleInstrumentActive = async (i: Instrument) => {
    try {
      await api.patch(`/proms/instruments/${i.id}`, { active: !i.active });
      load();
    } catch {
      setError('تعذر تغيير حالة المقياس.');
    }
  };

  const togglePathwayActive = async (p: Pathway) => {
    try {
      await api.patch(`/proms/pathways/${p.id}`, { active: !p.active });
      load();
    } catch {
      setError('تعذر تغيير حالة المسار.');
    }
  };

  // --- Instruments -----------------------------------------------------------
  const [iCode, setICode] = useState('');
  const [iNameAr, setINameAr] = useState('');
  const [iNameEn, setINameEn] = useState('');
  const [iDescAr, setIDescAr] = useState('');
  const [iLicense, setILicense] = useState<'free' | 'licensed_required'>('free');
  const [iHigherBetter, setIHigherBetter] = useState(false);
  const [iMcid, setIMcid] = useState(1);

  const createInstrument = async () => {
    setError(null);
    if (!iCode || !iNameAr || !iNameEn || !iDescAr) return;
    try {
      await api.post('/proms/instruments', {
        code: iCode,
        nameAr: iNameAr,
        nameEn: iNameEn,
        descriptionAr: iDescAr,
        licenseStatus: iLicense,
        higherIsBetter: iHigherBetter,
        mcidThreshold: iMcid
      });
      setICode('');
      setINameAr('');
      setINameEn('');
      setIDescAr('');
      load();
    } catch {
      setError('تعذر إنشاء المقياس — تحقق من عدم تكرار الرمز (code).');
    }
  };

  const [editingInstrument, setEditingInstrument] = useState<
    Record<string, { nameAr: string; nameEn: string; descriptionAr: string; higherIsBetter: boolean; mcidThreshold: number }>
  >({});

  const startEditInstrument = (i: Instrument) =>
    setEditingInstrument((prev) => ({
      ...prev,
      [i.id]: { nameAr: i.name_ar, nameEn: i.name_en, descriptionAr: i.description_ar, higherIsBetter: !!i.higher_is_better, mcidThreshold: i.mcid_threshold }
    }));

  const saveEditInstrument = async (id: string) => {
    const edit = editingInstrument[id];
    if (!edit) return;
    setError(null);
    try {
      await api.patch(`/proms/instruments/${id}`, {
        nameAr: edit.nameAr,
        nameEn: edit.nameEn,
        descriptionAr: edit.descriptionAr,
        higherIsBetter: edit.higherIsBetter,
        mcidThreshold: edit.mcidThreshold
      });
      setEditingInstrument((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      load();
    } catch {
      setError('تعذر حفظ تعديلات المقياس.');
    }
  };

  const [newItemDraft, setNewItemDraft] = useState<Record<string, { code: string; textAr: string; textEn: string; scaleMax: number; reverseScored: boolean }>>(
    {}
  );

  const addItem = async (instrumentId: string) => {
    const draft = newItemDraft[instrumentId];
    if (!draft || !draft.code || !draft.textAr || !draft.textEn) return;
    setError(null);
    try {
      await api.post(`/proms/instruments/${instrumentId}/items`, {
        code: draft.code,
        textAr: draft.textAr,
        textEn: draft.textEn,
        scaleMax: draft.scaleMax || 1,
        reverseScored: draft.reverseScored
      });
      setNewItemDraft((prev) => {
        const next = { ...prev };
        delete next[instrumentId];
        return next;
      });
      load();
    } catch {
      setError('تعذر إضافة العنصر — تحقق من عدم تكرار رمز العنصر داخل نفس المقياس.');
    }
  };

  const [editingItem, setEditingItem] = useState<Record<string, { textAr: string; textEn: string; scaleMax: number; reverseScored: boolean }>>({});

  const startEditItem = (item: InstrumentItem) =>
    setEditingItem((prev) => ({
      ...prev,
      [item.id]: { textAr: item.text_ar, textEn: item.text_en, scaleMax: item.scale_max, reverseScored: !!item.reverse_scored }
    }));

  const saveEditItem = async (id: string) => {
    const edit = editingItem[id];
    if (!edit) return;
    setError(null);
    try {
      await api.patch(`/proms/instrument-items/${id}`, {
        textAr: edit.textAr,
        textEn: edit.textEn,
        scaleMax: edit.scaleMax,
        reverseScored: edit.reverseScored
      });
      setEditingItem((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      load();
    } catch {
      setError('تعذر حفظ تعديلات العنصر.');
    }
  };

  // --- Pathways ----------------------------------------------------------
  const [pCode, setPCode] = useState('');
  const [pNameAr, setPNameAr] = useState('');
  const [pNameEn, setPNameEn] = useState('');

  const createPathway = async () => {
    setError(null);
    if (!pCode || !pNameAr || !pNameEn) return;
    try {
      await api.post('/proms/pathways', { code: pCode, nameAr: pNameAr, nameEn: pNameEn });
      setPCode('');
      setPNameAr('');
      setPNameEn('');
      load();
    } catch {
      setError('تعذر إنشاء المسار — تحقق من عدم تكرار الرمز (code).');
    }
  };

  const [editingPathway, setEditingPathway] = useState<Record<string, { nameAr: string; nameEn: string }>>({});

  const startEditPathway = (p: Pathway) => setEditingPathway((prev) => ({ ...prev, [p.id]: { nameAr: p.name_ar, nameEn: p.name_en } }));

  const saveEditPathway = async (id: string) => {
    const edit = editingPathway[id];
    if (!edit) return;
    setError(null);
    try {
      await api.patch(`/proms/pathways/${id}`, { nameAr: edit.nameAr, nameEn: edit.nameEn });
      setEditingPathway((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      load();
    } catch {
      setError('تعذر حفظ تعديلات المسار.');
    }
  };

  const [newTimepointDraft, setNewTimepointDraft] = useState<
    Record<string, { code: string; nameAr: string; offsetDays: number; windowDays: number; instrumentIds: string[] }>
  >({});

  const addTimepoint = async (pathwayId: string) => {
    const draft = newTimepointDraft[pathwayId];
    if (!draft || !draft.code || !draft.nameAr || draft.instrumentIds.length === 0) return;
    setError(null);
    try {
      await api.post(`/proms/pathways/${pathwayId}/timepoints`, {
        code: draft.code,
        nameAr: draft.nameAr,
        offsetDays: draft.offsetDays,
        windowDays: draft.windowDays || 14,
        instrumentIds: draft.instrumentIds
      });
      setNewTimepointDraft((prev) => {
        const next = { ...prev };
        delete next[pathwayId];
        return next;
      });
      load();
    } catch {
      setError('تعذر إضافة نقطة المتابعة.');
    }
  };

  const [editingTimepoint, setEditingTimepoint] = useState<Record<string, { nameAr: string; offsetDays: number; windowDays: number; instrumentIds: string[] }>>(
    {}
  );

  const startEditTimepoint = (t: Timepoint) =>
    setEditingTimepoint((prev) => ({
      ...prev,
      [t.id]: { nameAr: t.name_ar, offsetDays: t.offset_days, windowDays: t.window_days, instrumentIds: JSON.parse(t.instrument_ids_json) }
    }));

  const saveEditTimepoint = async (id: string) => {
    const edit = editingTimepoint[id];
    if (!edit) return;
    setError(null);
    try {
      await api.patch(`/proms/timepoints/${id}`, {
        nameAr: edit.nameAr,
        offsetDays: edit.offsetDays,
        windowDays: edit.windowDays,
        instrumentIds: edit.instrumentIds
      });
      setEditingTimepoint((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      load();
    } catch {
      setError('تعذر حفظ تعديلات نقطة المتابعة.');
    }
  };

  const toggleInstrumentInList = (list: string[], id: string): string[] =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

  return (
    <div className="space-y-6">
      {error && <p className="text-xs text-red-600">{error}</p>}

      {/* ================= Instruments ================= */}
      <div>
        <h3 className="mb-2 text-sm font-bold text-slate-700">مقاييس النتائج الصحية (Instruments)</h3>
        <div className="rounded-2xl bg-white p-4 shadow-sm">
          <h4 className="mb-3 text-sm font-semibold text-slate-700">إضافة مقياس جديد</h4>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <input value={iCode} onChange={(e) => setICode(e.target.value)} placeholder="الرمز (مثال: CUSTOM_SCALE)" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            <input value={iNameAr} onChange={(e) => setINameAr(e.target.value)} placeholder="الاسم بالعربية" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            <input value={iNameEn} onChange={(e) => setINameEn(e.target.value)} placeholder="الاسم بالإنجليزية" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            <input value={iDescAr} onChange={(e) => setIDescAr(e.target.value)} placeholder="وصف مختصر بالعربية" className="rounded-lg border border-slate-300 px-3 py-2 text-sm md:col-span-2" />
            <select value={iLicense} onChange={(e) => setILicense(e.target.value as 'free' | 'licensed_required')} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
              <option value="free">مجاني (يُرسل رقميًا للمريض)</option>
              <option value="licensed_required">يتطلب ترخيصًا (تعبئة يدوية فقط)</option>
            </select>
            <label className="flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600">
              <input type="checkbox" checked={iHigherBetter} onChange={(e) => setIHigherBetter(e.target.checked)} />
              رقم أعلى = حالة أفضل
            </label>
            <input
              type="number"
              min={0}
              step={0.5}
              value={iMcid}
              onChange={(e) => setIMcid(Number(e.target.value))}
              placeholder="الحد الأدنى للتحسن السريري (MCID)"
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <button type="button" onClick={createInstrument} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">
              إضافة مقياس
            </button>
          </div>
          <p className="mt-2 text-xs text-slate-400">
            "رقم أعلى = حالة أفضل" و"الحد الأدنى للتحسن" تُستخدمان لحساب التحسّن (Delta) وتحقق MCID للمقاييس الجديدة فقط —
            المقاييس المبرمجة مسبقًا (PHQ9، GAD7...) تستخدم منطق التصنيف السريري الخاص بها بغض النظر عن هذه القيم.
          </p>
        </div>

        <div className="mt-3 space-y-2">
          {instruments.map((i) => (
            <div key={i.id} className="rounded-2xl bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setExpandedInstrument(expandedInstrument === i.id ? null : i.id)}
                  className="flex flex-1 items-center justify-between text-right"
                >
                  <span className={`text-sm font-semibold ${i.active ? 'text-slate-800' : 'text-slate-400 line-through'}`}>
                    {i.name_ar} <span className="text-xs font-normal text-slate-400">({i.code}, {i.items.length} عنصر, {i.license_status === 'free' ? 'مجاني' : 'مرخّص'})</span>
                  </span>
                  <span className="text-xs text-slate-400">{expandedInstrument === i.id ? 'إغلاق' : 'تفاصيل'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => toggleInstrumentActive(i)}
                  className="shrink-0 text-xs font-semibold text-red-600 hover:underline"
                >
                  {i.active ? 'إيقاف' : 'تفعيل'}
                </button>
              </div>
              {expandedInstrument === i.id && (
                <div className="mt-3 space-y-3 border-t border-slate-100 pt-3">
                  {editingInstrument[i.id] ? (
                    <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                      <input
                        value={editingInstrument[i.id].nameAr}
                        onChange={(e) => setEditingInstrument((prev) => ({ ...prev, [i.id]: { ...prev[i.id], nameAr: e.target.value } }))}
                        className="rounded border border-slate-300 px-2 py-1 text-xs"
                        placeholder="الاسم بالعربية"
                      />
                      <input
                        value={editingInstrument[i.id].nameEn}
                        onChange={(e) => setEditingInstrument((prev) => ({ ...prev, [i.id]: { ...prev[i.id], nameEn: e.target.value } }))}
                        className="rounded border border-slate-300 px-2 py-1 text-xs"
                        placeholder="الاسم بالإنجليزية"
                      />
                      <input
                        type="number"
                        step={0.5}
                        value={editingInstrument[i.id].mcidThreshold}
                        onChange={(e) => setEditingInstrument((prev) => ({ ...prev, [i.id]: { ...prev[i.id], mcidThreshold: Number(e.target.value) } }))}
                        className="rounded border border-slate-300 px-2 py-1 text-xs"
                        placeholder="MCID"
                      />
                      <input
                        value={editingInstrument[i.id].descriptionAr}
                        onChange={(e) => setEditingInstrument((prev) => ({ ...prev, [i.id]: { ...prev[i.id], descriptionAr: e.target.value } }))}
                        className="rounded border border-slate-300 px-2 py-1 text-xs md:col-span-2"
                        placeholder="الوصف"
                      />
                      <label className="flex items-center gap-2 text-xs text-slate-600">
                        <input
                          type="checkbox"
                          checked={editingInstrument[i.id].higherIsBetter}
                          onChange={(e) => setEditingInstrument((prev) => ({ ...prev, [i.id]: { ...prev[i.id], higherIsBetter: e.target.checked } }))}
                        />
                        رقم أعلى = أفضل
                      </label>
                      <button onClick={() => saveEditInstrument(i.id)} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white">
                        حفظ
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-slate-500">{i.description_ar}</p>
                      <button onClick={() => startEditInstrument(i)} className="shrink-0 text-xs font-semibold text-slate-600 hover:underline">
                        تعديل بيانات المقياس
                      </button>
                    </div>
                  )}

                  <ul className="space-y-1">
                    {i.items.map((item) => (
                      <li key={item.id} className="rounded-lg bg-slate-50 p-2 text-xs">
                        {editingItem[item.id] ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <input
                              value={editingItem[item.id].textAr}
                              onChange={(e) => setEditingItem((prev) => ({ ...prev, [item.id]: { ...prev[item.id], textAr: e.target.value } }))}
                              className="min-w-[8rem] flex-1 rounded border border-slate-300 px-2 py-1"
                              placeholder="النص بالعربية"
                            />
                            <input
                              value={editingItem[item.id].textEn}
                              onChange={(e) => setEditingItem((prev) => ({ ...prev, [item.id]: { ...prev[item.id], textEn: e.target.value } }))}
                              className="min-w-[8rem] flex-1 rounded border border-slate-300 px-2 py-1"
                              placeholder="النص بالإنجليزية"
                            />
                            <input
                              type="number"
                              min={1}
                              value={editingItem[item.id].scaleMax}
                              onChange={(e) => setEditingItem((prev) => ({ ...prev, [item.id]: { ...prev[item.id], scaleMax: Number(e.target.value) } }))}
                              className="w-16 rounded border border-slate-300 px-2 py-1"
                              placeholder="الحد الأعلى"
                            />
                            <label className="flex items-center gap-1">
                              <input
                                type="checkbox"
                                checked={editingItem[item.id].reverseScored}
                                onChange={(e) => setEditingItem((prev) => ({ ...prev, [item.id]: { ...prev[item.id], reverseScored: e.target.checked } }))}
                              />
                              معكوس
                            </label>
                            <button onClick={() => saveEditItem(item.id)} className="font-semibold text-emerald-600 hover:underline">
                              حفظ
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-slate-600">
                              {item.text_ar} <span className="text-slate-400">(0-{item.scale_max}{item.reverse_scored ? '، معكوس' : ''})</span>
                            </span>
                            <button onClick={() => startEditItem(item)} className="shrink-0 font-semibold text-slate-600 hover:underline">
                              تعديل
                            </button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>

                  <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2">
                    <input
                      value={newItemDraft[i.id]?.code ?? ''}
                      onChange={(e) => setNewItemDraft((prev) => ({ ...prev, [i.id]: { ...(prev[i.id] ?? { textAr: '', textEn: '', scaleMax: 5, reverseScored: false }), code: e.target.value } }))}
                      placeholder="رمز العنصر"
                      className="w-24 rounded border border-slate-300 px-2 py-1 text-xs"
                    />
                    <input
                      value={newItemDraft[i.id]?.textAr ?? ''}
                      onChange={(e) => setNewItemDraft((prev) => ({ ...prev, [i.id]: { ...(prev[i.id] ?? { code: '', textEn: '', scaleMax: 5, reverseScored: false }), textAr: e.target.value } }))}
                      placeholder="النص بالعربية"
                      className="min-w-[8rem] flex-1 rounded border border-slate-300 px-2 py-1 text-xs"
                    />
                    <input
                      value={newItemDraft[i.id]?.textEn ?? ''}
                      onChange={(e) => setNewItemDraft((prev) => ({ ...prev, [i.id]: { ...(prev[i.id] ?? { code: '', textAr: '', scaleMax: 5, reverseScored: false }), textEn: e.target.value } }))}
                      placeholder="النص بالإنجليزية"
                      className="min-w-[8rem] flex-1 rounded border border-slate-300 px-2 py-1 text-xs"
                    />
                    <input
                      type="number"
                      min={1}
                      value={newItemDraft[i.id]?.scaleMax ?? 5}
                      onChange={(e) => setNewItemDraft((prev) => ({ ...prev, [i.id]: { ...(prev[i.id] ?? { code: '', textAr: '', textEn: '', reverseScored: false }), scaleMax: Number(e.target.value) } }))}
                      className="w-16 rounded border border-slate-300 px-2 py-1 text-xs"
                      placeholder="الحد الأعلى"
                    />
                    <button type="button" onClick={() => addItem(i.id)} className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white">
                      إضافة عنصر
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ================= Pathways ================= */}
      <div>
        <h3 className="mb-2 text-sm font-bold text-slate-700">مسارات الرعاية (Care Pathways)</h3>
        <div className="rounded-2xl bg-white p-4 shadow-sm">
          <h4 className="mb-3 text-sm font-semibold text-slate-700">إضافة مسار جديد</h4>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <input value={pCode} onChange={(e) => setPCode(e.target.value)} placeholder="الرمز (مثال: HIP_REPLACEMENT)" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            <input value={pNameAr} onChange={(e) => setPNameAr(e.target.value)} placeholder="الاسم بالعربية" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            <input value={pNameEn} onChange={(e) => setPNameEn(e.target.value)} placeholder="الاسم بالإنجليزية" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            <button type="button" onClick={createPathway} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">
              إضافة مسار
            </button>
          </div>
        </div>

        <div className="mt-3 space-y-2">
          {pathways.map((p) => (
            <div key={p.id} className="rounded-2xl bg-white p-4 shadow-sm">
              <button type="button" onClick={() => setExpandedPathway(expandedPathway === p.id ? null : p.id)} className="flex w-full items-center justify-between text-right">
                {editingPathway[p.id] ? (
                  <div className="flex flex-1 gap-2" onClick={(e) => e.stopPropagation()}>
                    <input
                      value={editingPathway[p.id].nameAr}
                      onChange={(e) => setEditingPathway((prev) => ({ ...prev, [p.id]: { ...prev[p.id], nameAr: e.target.value } }))}
                      className="rounded border border-slate-300 px-2 py-1 text-xs"
                    />
                    <input
                      value={editingPathway[p.id].nameEn}
                      onChange={(e) => setEditingPathway((prev) => ({ ...prev, [p.id]: { ...prev[p.id], nameEn: e.target.value } }))}
                      className="rounded border border-slate-300 px-2 py-1 text-xs"
                    />
                    <button onClick={() => saveEditPathway(p.id)} className="text-xs font-semibold text-emerald-600 hover:underline">
                      حفظ
                    </button>
                  </div>
                ) : (
                  <span className={`text-sm font-semibold ${p.active ? 'text-slate-800' : 'text-slate-400 line-through'}`}>
                    {p.name_ar} <span className="text-xs font-normal text-slate-400">({p.code}, {p.timepoints.length} نقطة متابعة)</span>
                  </span>
                )}
                <span className="flex shrink-0 items-center gap-3">
                  {!editingPathway[p.id] && (
                    <>
                      <span
                        role="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          startEditPathway(p);
                        }}
                        className="text-xs font-semibold text-slate-600 hover:underline"
                      >
                        تعديل
                      </span>
                      <span
                        role="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          togglePathwayActive(p);
                        }}
                        className="text-xs font-semibold text-red-600 hover:underline"
                      >
                        {p.active ? 'إيقاف' : 'تفعيل'}
                      </span>
                    </>
                  )}
                  <span className="text-xs text-slate-400">{expandedPathway === p.id ? 'إغلاق' : 'تفاصيل'}</span>
                </span>
              </button>
              {expandedPathway === p.id && (
                <div className="mt-3 space-y-2 border-t border-slate-100 pt-3">
                  {p.timepoints.map((t) => {
                    const instrumentIds: string[] = JSON.parse(t.instrument_ids_json);
                    return (
                      <div key={t.id} className="rounded-lg bg-slate-50 p-3 text-xs">
                        {editingTimepoint[t.id] ? (
                          <div className="space-y-2">
                            <div className="flex flex-wrap gap-2">
                              <input
                                value={editingTimepoint[t.id].nameAr}
                                onChange={(e) => setEditingTimepoint((prev) => ({ ...prev, [t.id]: { ...prev[t.id], nameAr: e.target.value } }))}
                                className="rounded border border-slate-300 px-2 py-1"
                                placeholder="الاسم"
                              />
                              <input
                                type="number"
                                value={editingTimepoint[t.id].offsetDays}
                                onChange={(e) => setEditingTimepoint((prev) => ({ ...prev, [t.id]: { ...prev[t.id], offsetDays: Number(e.target.value) } }))}
                                className="w-24 rounded border border-slate-300 px-2 py-1"
                                placeholder="أيام بعد البدء"
                              />
                              <input
                                type="number"
                                value={editingTimepoint[t.id].windowDays}
                                onChange={(e) => setEditingTimepoint((prev) => ({ ...prev, [t.id]: { ...prev[t.id], windowDays: Number(e.target.value) } }))}
                                className="w-24 rounded border border-slate-300 px-2 py-1"
                                placeholder="نافذة الاستجابة (أيام)"
                              />
                            </div>
                            <div className="flex flex-wrap gap-2">
                              {instruments.map((inst) => (
                                <label key={inst.id} className="flex items-center gap-1 rounded border border-slate-200 px-2 py-1">
                                  <input
                                    type="checkbox"
                                    checked={editingTimepoint[t.id].instrumentIds.includes(inst.id)}
                                    onChange={() =>
                                      setEditingTimepoint((prev) => ({
                                        ...prev,
                                        [t.id]: { ...prev[t.id], instrumentIds: toggleInstrumentInList(prev[t.id].instrumentIds, inst.id) }
                                      }))
                                    }
                                  />
                                  {inst.name_ar}
                                </label>
                              ))}
                            </div>
                            <button onClick={() => saveEditTimepoint(t.id)} className="rounded-lg bg-emerald-600 px-3 py-1.5 font-semibold text-white">
                              حفظ
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center justify-between">
                            <span className="text-slate-600">
                              {t.name_ar} — بعد {t.offset_days} يوم، نافذة {t.window_days} يوم —{' '}
                              {instrumentIds.map((id) => instruments.find((inst) => inst.id === id)?.name_ar).filter(Boolean).join('، ')}
                            </span>
                            <button onClick={() => startEditTimepoint(t)} className="shrink-0 font-semibold text-slate-600 hover:underline">
                              تعديل
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  <div className="space-y-2 border-t border-slate-100 pt-2">
                    <div className="flex flex-wrap gap-2">
                      <input
                        value={newTimepointDraft[p.id]?.code ?? ''}
                        onChange={(e) =>
                          setNewTimepointDraft((prev) => ({
                            ...prev,
                            [p.id]: { ...(prev[p.id] ?? { nameAr: '', offsetDays: 0, windowDays: 14, instrumentIds: [] }), code: e.target.value }
                          }))
                        }
                        placeholder="رمز نقطة المتابعة"
                        className="w-28 rounded border border-slate-300 px-2 py-1 text-xs"
                      />
                      <input
                        value={newTimepointDraft[p.id]?.nameAr ?? ''}
                        onChange={(e) =>
                          setNewTimepointDraft((prev) => ({
                            ...prev,
                            [p.id]: { ...(prev[p.id] ?? { code: '', offsetDays: 0, windowDays: 14, instrumentIds: [] }), nameAr: e.target.value }
                          }))
                        }
                        placeholder="الاسم بالعربية"
                        className="min-w-[8rem] flex-1 rounded border border-slate-300 px-2 py-1 text-xs"
                      />
                      <input
                        type="number"
                        value={newTimepointDraft[p.id]?.offsetDays ?? 0}
                        onChange={(e) =>
                          setNewTimepointDraft((prev) => ({
                            ...prev,
                            [p.id]: { ...(prev[p.id] ?? { code: '', nameAr: '', windowDays: 14, instrumentIds: [] }), offsetDays: Number(e.target.value) }
                          }))
                        }
                        placeholder="أيام بعد البدء"
                        className="w-24 rounded border border-slate-300 px-2 py-1 text-xs"
                      />
                      <input
                        type="number"
                        value={newTimepointDraft[p.id]?.windowDays ?? 14}
                        onChange={(e) =>
                          setNewTimepointDraft((prev) => ({
                            ...prev,
                            [p.id]: { ...(prev[p.id] ?? { code: '', nameAr: '', offsetDays: 0, instrumentIds: [] }), windowDays: Number(e.target.value) }
                          }))
                        }
                        placeholder="نافذة الاستجابة (أيام)"
                        className="w-28 rounded border border-slate-300 px-2 py-1 text-xs"
                      />
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {instruments.map((inst) => (
                        <label key={inst.id} className="flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-xs">
                          <input
                            type="checkbox"
                            checked={newTimepointDraft[p.id]?.instrumentIds.includes(inst.id) ?? false}
                            onChange={() =>
                              setNewTimepointDraft((prev) => ({
                                ...prev,
                                [p.id]: {
                                  ...(prev[p.id] ?? { code: '', nameAr: '', offsetDays: 0, windowDays: 14, instrumentIds: [] }),
                                  instrumentIds: toggleInstrumentInList(prev[p.id]?.instrumentIds ?? [], inst.id)
                                }
                              }))
                            }
                          />
                          {inst.name_ar}
                        </label>
                      ))}
                    </div>
                    <button type="button" onClick={() => addTimepoint(p.id)} className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white">
                      إضافة نقطة متابعة
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
