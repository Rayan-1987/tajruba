import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../AuthContext';
import { CATEGORY_LABELS_AR, STATUS_LABELS_AR } from '../types';

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
}

interface AssignableUser {
  id: string;
  full_name: string;
  role: string;
}

const COLUMNS: RecoveryCase['status'][] = ['new', 'assigned', 'in_progress', 'closed'];
const NEXT_STATUS: Record<string, RecoveryCase['status']> = { new: 'assigned', assigned: 'in_progress', in_progress: 'closed' };

export default function ServiceRecovery() {
  const { user } = useAuth();
  const [cases, setCases] = useState<RecoveryCase[]>([]);
  const [notesDraft, setNotesDraft] = useState<Record<string, string>>({});
  const [assignableByDept, setAssignableByDept] = useState<Record<string, AssignableUser[]>>({});
  const [dueDraft, setDueDraft] = useState<Record<string, string>>({});

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
    </div>
  );
}
