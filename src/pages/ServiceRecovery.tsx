import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../AuthContext';
import { CATEGORY_LABELS_AR, STATUS_LABELS_AR } from '../types';
import type { Department } from '../types';

interface RecoveryCase {
  id: string;
  comment_id: string;
  status: 'new' | 'assigned' | 'in_progress' | 'closed';
  department_id: string;
  assigned_to: string | null;
  assigned_to_name: string | null;
  due_at: string | null;
  opened_at: string;
  closed_at: string | null;
  resolution_notes: string | null;
  redacted_text: string;
  severity: number;
  category: string;
  patient_contact_opt_in: number;
  patient_notified_at: string | null;
  escalation_level: number;
  improvement_plan_id: string | null;
  improvement_plan_title: string | null;
  improvement_plan_status: string | null;
}

interface AssignableUser {
  id: string;
  full_name: string;
  role: string;
}

interface ImprovementPlan {
  id: string;
  title: string;
  corrective_action: string | null;
  status: string;
  due_date: string | null;
  effectiveness_notes: string | null;
  department_id: string | null;
  department_name_ar: string | null;
  owner_name: string | null;
  created_at: string;
}

const ESCALATION_LABELS_AR: Record<number, string> = { 1: 'تصعيد: مدير الجودة', 2: 'تصعيد: الإدارة التنفيذية' };

const COLUMNS: RecoveryCase['status'][] = ['new', 'assigned', 'in_progress', 'closed'];
const NEXT_STATUS: Record<string, RecoveryCase['status']> = { new: 'assigned', assigned: 'in_progress', in_progress: 'closed' };

export default function ServiceRecovery() {
  const { user } = useAuth();
  const [cases, setCases] = useState<RecoveryCase[]>([]);
  const [notesDraft, setNotesDraft] = useState<Record<string, string>>({});
  const [assignableByDept, setAssignableByDept] = useState<Record<string, AssignableUser[]>>({});
  const [dueDraft, setDueDraft] = useState<Record<string, string>>({});
  const [plans, setPlans] = useState<ImprovementPlan[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [newPlanTitle, setNewPlanTitle] = useState('');
  const [newPlanDept, setNewPlanDept] = useState('');

  const loadPlans = () => {
    api.get<{ plans: ImprovementPlan[] }>('/service-recovery/improvement-plans').then((res) => setPlans(res.plans));
  };
  useEffect(loadPlans, []);
  useEffect(() => {
    api.get<{ departments: Department[] }>('/departments').then((res) => setDepartments(res.departments));
  }, []);

  const createPlan = async () => {
    if (!newPlanTitle.trim()) return;
    await api.post('/service-recovery/improvement-plans', { title: newPlanTitle.trim(), departmentId: newPlanDept || undefined });
    setNewPlanTitle('');
    setNewPlanDept('');
    loadPlans();
  };

  const updatePlanStatus = async (planId: string, status: string) => {
    await api.patch(`/service-recovery/improvement-plans/${planId}`, { status });
    loadPlans();
    load();
  };

  const linkPlan = async (c: RecoveryCase, planId: string) => {
    await api.patch(`/service-recovery/cases/${c.id}/link-plan`, { improvementPlanId: planId || null });
    load();
  };

  const load = () => {
    api.get<{ cases: RecoveryCase[] }>('/service-recovery/cases').then((res) => {
      setCases(res.cases);
      const departmentIds = Array.from(new Set(res.cases.map((c) => c.department_id)));
      departmentIds
        .filter((id) => !assignableByDept[id])
        .forEach((id) => {
          api
            .get<{ users: AssignableUser[] }>(`/service-recovery/assignable-users?departmentId=${id}`)
            .then((r) => setAssignableByDept((prev) => ({ ...prev, [id]: r.users })));
        });
    });
  };
  useEffect(load, []);

  const assign = async (c: RecoveryCase, assignedTo?: string, dueAt?: string) => {
    await api.patch(`/service-recovery/cases/${c.id}/assign`, { assignedTo, dueAt });
    load();
  };

  const advance = async (c: RecoveryCase) => {
    const nextStatus = NEXT_STATUS[c.status];
    if (!nextStatus) return;
    if (nextStatus === 'closed' && user?.role === 'DepartmentManager') {
      alert('إغلاق الحالة يتطلب اعتماد إدارة تجربة المريض (متطلب CBAHI للتوثيق).');
      return;
    }
    const res = await api.patch<{ patientNotified: boolean }>(`/comments/${c.comment_id}/status`, {
      status: nextStatus,
      resolutionNotes: notesDraft[c.id] || undefined
    });
    if (nextStatus === 'closed' && c.patient_contact_opt_in && res.patientNotified) {
      alert('تم إشعار المريض برسالة نصية بأن ملاحظته تمت معالجتها.');
    }
    load();
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-800">استعادة الخدمة (Service Recovery)</h2>
        <p className="text-sm text-slate-500">دورة حياة موثّقة: جديد ← مُسند ← تحت المعالجة ← مغلق (يتطلب اعتماد الجودة)</p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        {COLUMNS.map((status) => (
          <div key={status} className="rounded-2xl bg-slate-100 p-3">
            <h3 className="mb-3 px-1 text-sm font-bold text-slate-600">
              {STATUS_LABELS_AR[status]} ({cases.filter((c) => c.status === status).length})
            </h3>
            <div className="space-y-2">
              {cases
                .filter((c) => c.status === status)
                .map((c) => (
                  <div key={c.id} className="rounded-xl bg-white p-3 shadow-sm">
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700">خطورة {c.severity}</span>
                      <span className="text-[10px] text-slate-400">{CATEGORY_LABELS_AR[c.category] ?? c.category}</span>
                      {c.patient_contact_opt_in === 1 && (
                        <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold text-blue-700">
                          {c.patient_notified_at ? '✓ تم إشعار المريض' : 'سيُشعَر المريض عند الإغلاق'}
                        </span>
                      )}
                      {status !== 'closed' && c.due_at && new Date(c.due_at) < new Date() && (
                        <span className="rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-semibold text-white">متأخرة عن الموعد</span>
                      )}
                      {c.escalation_level > 0 && (
                        <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-semibold text-orange-700">
                          {ESCALATION_LABELS_AR[c.escalation_level] ?? `مستوى تصعيد ${c.escalation_level}`}
                        </span>
                      )}
                    </div>
                    <p className="mb-2 text-xs text-slate-700">{c.redacted_text}</p>
                    {c.resolution_notes && <p className="mb-2 text-[11px] text-slate-500">{c.resolution_notes}</p>}
                    {status !== 'closed' && (
                      <div className="mb-2 flex flex-wrap gap-1.5">
                        <select
                          value={c.assigned_to ?? ''}
                          onChange={(e) => assign(c, e.target.value || undefined, undefined)}
                          className="flex-1 rounded-lg border border-slate-200 p-1 text-[11px]"
                        >
                          <option value="">لم تُسند بعد</option>
                          {(assignableByDept[c.department_id] ?? []).map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.full_name}
                            </option>
                          ))}
                        </select>
                        <input
                          type="date"
                          value={dueDraft[c.id] ?? (c.due_at ? c.due_at.slice(0, 10) : '')}
                          onChange={(e) => setDueDraft((prev) => ({ ...prev, [c.id]: e.target.value }))}
                          onBlur={(e) => e.target.value && assign(c, undefined, new Date(e.target.value).toISOString())}
                          className="rounded-lg border border-slate-200 p-1 text-[11px]"
                        />
                      </div>
                    )}
                    {c.assigned_to_name && <p className="mb-2 text-[11px] text-slate-500">المسؤول: {c.assigned_to_name}</p>}
                    <select
                      value={c.improvement_plan_id ?? ''}
                      onChange={(e) => linkPlan(c, e.target.value)}
                      className="mb-2 w-full rounded-lg border border-slate-200 p-1 text-[11px] text-slate-600"
                      title="ربط بخطة تحسين (RFP SRC-06)"
                    >
                      <option value="">بدون خطة تحسين مرتبطة</option>
                      {plans
                        .filter((p) => !p.department_id || p.department_id === c.department_id)
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.title}
                          </option>
                        ))}
                    </select>
                    {status !== 'closed' && (
                      <>
                        {status !== 'new' && (
                          <textarea
                            value={notesDraft[c.id] ?? ''}
                            onChange={(e) => setNotesDraft((prev) => ({ ...prev, [c.id]: e.target.value }))}
                            placeholder="ملاحظة الإجراء التصحيحي..."
                            rows={2}
                            className="mb-2 w-full rounded-lg border border-slate-200 p-1.5 text-[11px]"
                          />
                        )}
                        <button
                          type="button"
                          onClick={() => advance(c)}
                          className="w-full rounded-lg bg-slate-800 py-1 text-[11px] font-semibold text-white hover:bg-slate-700"
                        >
                          نقل إلى {STATUS_LABELS_AR[NEXT_STATUS[status]]}
                        </button>
                      </>
                    )}
                  </div>
                ))}
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-2xl bg-white p-4 shadow-sm">
        <h3 className="mb-1 text-sm font-semibold text-slate-700">خطط التحسين (إجراءات تصحيحية ووقائية)</h3>
        <p className="mb-3 text-xs text-slate-500">اربط أي بلاغ بخطة تحسين لمعالجة السبب الجذري بدلاً من إغلاق كل بلاغ منفردًا، وتابع فاعليتها لاحقًا.</p>
        <div className="mb-3 flex flex-wrap gap-2">
          <input
            value={newPlanTitle}
            onChange={(e) => setNewPlanTitle(e.target.value)}
            placeholder="عنوان خطة التحسين"
            className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <select
            value={newPlanDept}
            onChange={(e) => setNewPlanDept(e.target.value)}
            disabled={user?.role === 'DepartmentManager'}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-100"
          >
            <option value="">كل الأقسام</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name_ar}
              </option>
            ))}
          </select>
          <button type="button" onClick={createPlan} className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700">
            إضافة خطة
          </button>
        </div>
        {plans.length === 0 ? (
          <p className="text-xs text-slate-400">لا توجد خطط تحسين بعد.</p>
        ) : (
          <div className="space-y-2">
            {plans.map((p) => (
              <div key={p.id} className="flex items-center justify-between rounded-xl border border-slate-100 p-3">
                <div>
                  <p className="text-sm font-semibold text-slate-700">{p.title}</p>
                  <p className="text-xs text-slate-400">
                    {p.department_name_ar ?? 'كل الأقسام'} {p.owner_name ? `· ${p.owner_name}` : ''}
                  </p>
                </div>
                <select
                  value={p.status}
                  onChange={(e) => updatePlanStatus(p.id, e.target.value)}
                  className="rounded-lg border border-slate-200 px-2 py-1 text-xs"
                >
                  <option value="open">مفتوحة</option>
                  <option value="in_progress">قيد التنفيذ</option>
                  <option value="done">منجزة</option>
                </select>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
