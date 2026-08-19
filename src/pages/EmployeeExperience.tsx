import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../AuthContext';

interface Instrument {
  id: string;
  code: string;
  name_ar: string;
  name_en: string;
  kind: 'annual' | 'pulse';
  active: number;
}

interface DomainScore {
  domainId: string;
  nameAr: string;
  nameEn: string;
  isDriver: boolean;
  n: number;
  mean: number | null;
  agreePercent: number | null;
}

interface DashboardResponse {
  n: number;
  suppressed: boolean;
  minGroupSize?: number;
  participationRate: number | null;
  enps: number | null;
  avgRecommendation: number | null;
  domains: DomainScore[];
  departmentBreakdown?: { departmentId: string | null; departmentNameAr: string | null; n: number; suppressed: boolean }[];
}

interface DriverItem {
  domainId: string;
  nameAr: string;
  nameEn: string;
  n: number;
  correlation: number | null;
}

interface Department {
  id: string;
  name_ar: string;
  name_en: string;
}

interface ImprovementPlan {
  id: string;
  title: string;
  status: string;
  due_date: string | null;
  department_name_ar: string | null;
  owner_name: string | null;
}

export default function EmployeeExperience() {
  const { user } = useAuth();
  const canManage = user?.role === 'SystemAdmin' || user?.role === 'QualityManager';

  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [instrumentId, setInstrumentId] = useState('');
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [drivers, setDrivers] = useState<DriverItem[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [plans, setPlans] = useState<ImprovementPlan[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [newEmployee, setNewEmployee] = useState({ departmentId: '', jobCategory: '', contactChannel: 'email' as 'email' | 'sms', contactValue: '' });
  const [inviteCohort, setInviteCohort] = useState({ departmentId: '', jobCategory: '' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ instruments: Instrument[] }>('/employee-experience/instruments').then((res) => {
      setInstruments(res.instruments);
      if (res.instruments.length > 0) setInstrumentId(res.instruments[0].id);
    });
    api.get<{ departments: Department[] }>('/departments').then((res) => setDepartments(res.departments));
    if (canManage) {
      api.get<{ plans: ImprovementPlan[] }>('/employee-experience/improvement-plans').then((res) => setPlans(res.plans));
    }
  }, [canManage]);

  useEffect(() => {
    if (!instrumentId) return;
    setError(null);
    api
      .get<DashboardResponse>(`/employee-experience/dashboard?instrumentId=${instrumentId}`)
      .then(setDashboard)
      .catch(() => setError('تعذر تحميل لوحة تجربة الموظف.'));
    api
      .get<{ items: DriverItem[] }>(`/employee-experience/driver-analysis?instrumentId=${instrumentId}`)
      .then((res) => setDrivers(res.items))
      .catch(() => setDrivers([]));
  }, [instrumentId]);

  const addEmployee = async () => {
    if (!newEmployee.jobCategory.trim() || !newEmployee.contactValue.trim()) return;
    setBusy(true);
    setNotice(null);
    try {
      await api.post('/employee-experience/employees', {
        departmentId: newEmployee.departmentId || undefined,
        jobCategory: newEmployee.jobCategory.trim(),
        contactChannel: newEmployee.contactChannel,
        contactValue: newEmployee.contactValue.trim()
      });
      setNewEmployee({ departmentId: '', jobCategory: '', contactChannel: 'email', contactValue: '' });
      setNotice('تمت إضافة الموظف إلى القائمة.');
    } catch {
      setNotice('تعذر إضافة الموظف.');
    } finally {
      setBusy(false);
    }
  };

  const sendInvitations = async () => {
    if (!instrumentId) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await api.post<{ sent: number }>('/employee-experience/invitations', {
        instrumentId,
        departmentId: inviteCohort.departmentId || undefined,
        jobCategory: inviteCohort.jobCategory || undefined
      });
      setNotice(`تم إرسال ${res.sent} دعوة مجهولة الهوية.`);
    } catch {
      setNotice('تعذر إرسال الدعوات.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-800">تجربة الموظف والارتباط الوظيفي</h2>
        <p className="text-sm text-slate-500">قياس مجهول تمامًا لرضا وارتباط الموظفين — النتائج التفصيلية لأي فئة أقل من {dashboard?.minGroupSize ?? 5} مستجيبين تُخفى تلقائيًا.</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <select
          value={instrumentId}
          onChange={(e) => setInstrumentId(e.target.value)}
          className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
        >
          {instruments.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name_ar} ({i.kind === 'annual' ? 'سنوية' : 'نبضية'})
            </option>
          ))}
        </select>
      </div>

      {error && <p className="text-sm text-rose-600">{error}</p>}

      {dashboard && dashboard.suppressed && (
        <div className="rounded-2xl bg-amber-50 p-4 text-sm text-amber-800">
          عدد المستجيبين حاليًا ({dashboard.n}) أقل من الحد الأدنى لعرض النتائج ({dashboard.minGroupSize}) حفاظًا على سرية المشاركين.
        </div>
      )}

      {dashboard && !dashboard.suppressed && (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="rounded-2xl bg-white p-5 shadow-sm">
              <p className="text-xs text-slate-500">معدل المشاركة (موافق/موافق بشدة)</p>
              <p className="mt-1 text-3xl font-bold text-emerald-600">{dashboard.participationRate ?? '—'}%</p>
            </div>
            <div className="rounded-2xl bg-white p-5 shadow-sm">
              <p className="text-xs text-slate-500">مؤشر التوصية eNPS (نسبة 9–10)</p>
              <p className="mt-1 text-3xl font-bold text-emerald-600">{dashboard.enps ?? '—'}%</p>
              {dashboard.avgRecommendation !== null && <p className="mt-0.5 text-xs text-slate-400">متوسط الدرجة: {dashboard.avgRecommendation}/10</p>}
            </div>
            <div className="rounded-2xl bg-white p-5 shadow-sm">
              <p className="text-xs text-slate-500">عدد المستجيبين</p>
              <p className="mt-1 text-3xl font-bold text-slate-700">{dashboard.n}</p>
            </div>
          </div>

          <div className="rounded-2xl bg-white p-5 shadow-sm">
            <h3 className="mb-3 font-semibold text-slate-800">المحاور</h3>
            <div className="space-y-2">
              {dashboard.domains.map((d) => (
                <div key={d.domainId} className="flex items-center justify-between border-b border-slate-100 py-2 text-sm last:border-0">
                  <span className="text-slate-700">
                    {d.nameAr} {!d.isDriver && <span className="text-xs text-slate-400">(مؤشر عام)</span>}
                  </span>
                  <span className="font-semibold text-slate-800">
                    {d.agreePercent ?? '—'}% <span className="font-normal text-slate-400">({d.mean ?? '—'}/5)</span>
                  </span>
                </div>
              ))}
            </div>
          </div>

          {drivers.length > 0 && (
            <div className="rounded-2xl bg-white p-5 shadow-sm">
              <h3 className="mb-3 font-semibold text-slate-800">محركات الارتباط الأكثر تأثيرًا</h3>
              <div className="space-y-2">
                {drivers.map((item) => (
                  <div key={item.domainId} className="flex items-center justify-between border-b border-slate-100 py-2 text-sm last:border-0">
                    <span className="text-slate-700">{item.nameAr}</span>
                    <span className="font-mono text-xs text-slate-500">r = {item.correlation ?? '—'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {dashboard.departmentBreakdown && dashboard.departmentBreakdown.length > 0 && (
            <div className="rounded-2xl bg-white p-5 shadow-sm">
              <h3 className="mb-3 font-semibold text-slate-800">التوزيع حسب القسم</h3>
              <div className="space-y-1">
                {dashboard.departmentBreakdown.map((row) => (
                  <div key={row.departmentId ?? 'none'} className="flex items-center justify-between border-b border-slate-100 py-1.5 text-sm last:border-0">
                    <span className="text-slate-600">{row.departmentNameAr ?? 'غير محدد'}</span>
                    <span className={row.suppressed ? 'text-xs text-amber-600' : 'text-slate-700'}>
                      {row.suppressed ? `مخفي (n<${dashboard.minGroupSize ?? 5})` : `n = ${row.n}`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {canManage && (
        <>
          <div className="rounded-2xl bg-white p-5 shadow-sm">
            <h3 className="mb-3 font-semibold text-slate-800">إضافة موظف إلى القائمة</h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
              <select
                value={newEmployee.departmentId}
                onChange={(e) => setNewEmployee((prev) => ({ ...prev, departmentId: e.target.value }))}
                className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
              >
                <option value="">بدون قسم محدد</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name_ar}
                  </option>
                ))}
              </select>
              <input
                value={newEmployee.jobCategory}
                onChange={(e) => setNewEmployee((prev) => ({ ...prev, jobCategory: e.target.value }))}
                placeholder="الفئة الوظيفية (تمريض، إداري...)"
                className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
              />
              <select
                value={newEmployee.contactChannel}
                onChange={(e) => setNewEmployee((prev) => ({ ...prev, contactChannel: e.target.value as 'email' | 'sms' }))}
                className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
              >
                <option value="email">بريد إلكتروني</option>
                <option value="sms">جوال (SMS)</option>
              </select>
              <input
                value={newEmployee.contactValue}
                onChange={(e) => setNewEmployee((prev) => ({ ...prev, contactValue: e.target.value }))}
                placeholder={newEmployee.contactChannel === 'email' ? 'name@hospital.sa' : '05xxxxxxxx'}
                className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
              />
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={addEmployee}
              className="mt-3 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              إضافة
            </button>
          </div>

          <div className="rounded-2xl bg-white p-5 shadow-sm">
            <h3 className="mb-3 font-semibold text-slate-800">إرسال دعوات مجهولة لفئة موظفين</h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <select
                value={inviteCohort.departmentId}
                onChange={(e) => setInviteCohort((prev) => ({ ...prev, departmentId: e.target.value }))}
                className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
              >
                <option value="">كل الأقسام</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name_ar}
                  </option>
                ))}
              </select>
              <input
                value={inviteCohort.jobCategory}
                onChange={(e) => setInviteCohort((prev) => ({ ...prev, jobCategory: e.target.value }))}
                placeholder="فئة وظيفية محددة (اختياري)"
                className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
              />
            </div>
            <button
              type="button"
              disabled={busy || !instrumentId}
              onClick={sendInvitations}
              className="mt-3 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              إرسال الدعوات
            </button>
            {notice && <p className="mt-2 text-sm text-slate-600">{notice}</p>}
          </div>

          <div className="rounded-2xl bg-white p-5 shadow-sm">
            <h3 className="mb-3 font-semibold text-slate-800">خطط التحسين</h3>
            {plans.length === 0 ? (
              <p className="text-sm text-slate-400">لا توجد خطط تحسين بعد.</p>
            ) : (
              <div className="space-y-2">
                {plans.map((p) => (
                  <div key={p.id} className="flex items-center justify-between border-b border-slate-100 py-2 text-sm last:border-0">
                    <div>
                      <p className="text-slate-700">{p.title}</p>
                      <p className="text-xs text-slate-400">
                        {p.department_name_ar ?? 'عام'} {p.owner_name ? `· ${p.owner_name}` : ''} {p.due_date ? `· يستحق ${p.due_date}` : ''}
                      </p>
                    </div>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{p.status}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
