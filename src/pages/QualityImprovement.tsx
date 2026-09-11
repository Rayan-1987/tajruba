import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Department } from '../types';

type QiPhaseCode = 'FIND' | 'ORGANIZE' | 'CLARIFY' | 'UNDERSTAND' | 'SELECT' | 'PLAN' | 'DO' | 'CHECK' | 'ACT';

const PHASE_ORDER: QiPhaseCode[] = ['FIND', 'ORGANIZE', 'CLARIFY', 'UNDERSTAND', 'SELECT', 'PLAN', 'DO', 'CHECK', 'ACT'];

const PHASE_LABELS_AR: Record<QiPhaseCode, string> = {
  FIND: 'تحديد المشكلة (Find)',
  ORGANIZE: 'تشكيل الفريق (Organize)',
  CLARIFY: 'توضيح المعرفة الحالية (Clarify)',
  UNDERSTAND: 'فهم أسباب المشكلة (Understand)',
  SELECT: 'اختيار الحل (Select)',
  PLAN: 'التخطيط (Plan)',
  DO: 'التنفيذ (Do)',
  CHECK: 'التحقق من النتائج (Check)',
  ACT: 'تثبيت التحسين (Act)'
};

const PHASE_STATUS_LABELS_AR: Record<string, string> = { pending: 'لم يبدأ', in_progress: 'قيد العمل', done: 'مكتمل' };
const PROJECT_STATUS_LABELS_AR: Record<string, string> = { open: 'مفتوح', in_progress: 'قيد التنفيذ', completed: 'مكتمل', on_hold: 'متوقف مؤقتًا' };

interface QiProjectSummary {
  id: string;
  title: string;
  problem_statement: string | null;
  status: string;
  created_at: string;
  department_id: string | null;
  department_name_ar: string | null;
  owner_name: string | null;
  linked_domain_name_ar: string | null;
  phases_done: number;
  cycle_count: number;
}

interface QiPhase {
  id: string;
  phase_code: QiPhaseCode;
  sort_order: number;
  notes: string | null;
  status: 'pending' | 'in_progress' | 'done';
  completed_at: string | null;
}

interface QiTeamMember {
  id: string;
  name: string;
  role_label: string | null;
  user_id: string | null;
  user_full_name: string | null;
  added_at: string;
}

interface QiCycle {
  id: string;
  cycle_number: number;
  metric_label: string | null;
  baseline_value: number | null;
  result_value: number | null;
  plan_notes: string | null;
  do_notes: string | null;
  check_notes: string | null;
  act_notes: string | null;
  status: 'open' | 'completed';
  started_at: string;
  completed_at: string | null;
}

interface QiProjectDetail {
  project: QiProjectSummary & { owner_user_id: string | null; linked_domain_id: string | null };
  phases: QiPhase[];
  team: QiTeamMember[];
  cycles: QiCycle[];
}

interface AssignableUser {
  id: string;
  full_name: string;
  role: string;
}

export default function QualityImprovement() {
  const [projects, setProjects] = useState<QiProjectSummary[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<QiProjectDetail | null>(null);
  const [assignable, setAssignable] = useState<AssignableUser[]>([]);

  const [newTitle, setNewTitle] = useState('');
  const [newProblem, setNewProblem] = useState('');
  const [newDept, setNewDept] = useState('');

  const [phaseNotesDraft, setPhaseNotesDraft] = useState<Record<string, string>>({});
  const [newMemberName, setNewMemberName] = useState('');
  const [newMemberRole, setNewMemberRole] = useState('');
  const [newCycleMetric, setNewCycleMetric] = useState('');
  const [newCycleBaseline, setNewCycleBaseline] = useState('');
  const [cycleDrafts, setCycleDrafts] = useState<Record<string, Partial<QiCycle>>>({});

  const loadProjects = () => {
    api.get<{ projects: QiProjectSummary[] }>('/qi-projects').then((res) => setProjects(res.projects));
  };
  useEffect(loadProjects, []);
  useEffect(() => {
    api.get<{ departments: Department[] }>('/departments').then((res) => setDepartments(res.departments));
  }, []);
  useEffect(() => {
    api.get<{ users: AssignableUser[] }>(`/service-recovery/assignable-users${newDept ? `?departmentId=${newDept}` : ''}`).then((res) => setAssignable(res.users));
  }, [newDept]);

  const loadDetail = (id: string) => {
    api.get<QiProjectDetail>(`/qi-projects/${id}`).then(setDetail);
  };

  useEffect(() => {
    if (selectedId) loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId]);

  const createProject = async () => {
    if (!newTitle.trim()) return;
    const res = await api.post<{ id: string }>('/qi-projects', {
      title: newTitle.trim(),
      problemStatement: newProblem.trim() || undefined,
      departmentId: newDept || undefined
    });
    setNewTitle('');
    setNewProblem('');
    setNewDept('');
    loadProjects();
    setSelectedId(res.id);
  };

  const updatePhase = async (phaseCode: QiPhaseCode, patch: { notes?: string; status?: 'pending' | 'in_progress' | 'done' }) => {
    if (!selectedId) return;
    await api.patch(`/qi-projects/${selectedId}/phases/${phaseCode}`, patch);
    loadDetail(selectedId);
    loadProjects();
  };

  const addMember = async () => {
    if (!selectedId || !newMemberName.trim()) return;
    await api.post(`/qi-projects/${selectedId}/team`, { name: newMemberName.trim(), roleLabel: newMemberRole.trim() || undefined });
    setNewMemberName('');
    setNewMemberRole('');
    loadDetail(selectedId);
  };

  const removeMember = async (memberId: string) => {
    if (!selectedId) return;
    await api.delete(`/qi-projects/${selectedId}/team/${memberId}`);
    loadDetail(selectedId);
  };

  const addCycle = async () => {
    if (!selectedId) return;
    await api.post(`/qi-projects/${selectedId}/cycles`, {
      metricLabel: newCycleMetric.trim() || undefined,
      baselineValue: newCycleBaseline.trim() ? Number(newCycleBaseline) : undefined
    });
    setNewCycleMetric('');
    setNewCycleBaseline('');
    loadDetail(selectedId);
  };

  const saveCycle = async (cycleId: string, patch: Partial<QiCycle>) => {
    if (!selectedId) return;
    await api.patch(`/qi-projects/${selectedId}/cycles/${cycleId}`, {
      planNotes: patch.plan_notes,
      doNotes: patch.do_notes,
      checkNotes: patch.check_notes,
      actNotes: patch.act_notes,
      resultValue: patch.result_value,
      status: patch.status
    });
    loadDetail(selectedId);
  };

  if (selectedId && detail) {
    const p = detail.project;
    return (
      <div className="space-y-6">
        <div>
          <button type="button" onClick={() => setSelectedId(null)} className="mb-2 text-sm font-semibold text-slate-500 hover:underline">
            ← كل المشاريع
          </button>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-bold text-slate-800">{p.title}</h2>
              {p.problem_statement && <p className="mt-1 max-w-2xl text-sm text-slate-500">{p.problem_statement}</p>}
              <p className="mt-1 text-xs text-slate-400">
                {p.department_name_ar ?? 'كل الأقسام'} {p.owner_name ? `· المسؤول: ${p.owner_name}` : ''}{' '}
                {p.linked_domain_name_ar ? `· مرتبط بمحور: ${p.linked_domain_name_ar}` : ''}
              </p>
            </div>
            <select
              value={p.status}
              onChange={(e) => api.patch(`/qi-projects/${p.id}`, { status: e.target.value }).then(() => { loadDetail(p.id); loadProjects(); })}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              {Object.entries(PROJECT_STATUS_LABELS_AR).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="rounded-2xl bg-white p-4 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold text-slate-700">مراحل FOCUS-PDCA</h3>
          <div className="space-y-2">
            {PHASE_ORDER.map((code) => {
              const phase = detail.phases.find((ph) => ph.phase_code === code);
              if (!phase) return null;
              const draftKey = phase.id;
              const notesValue = phaseNotesDraft[draftKey] ?? phase.notes ?? '';
              return (
                <div
                  key={code}
                  className={`rounded-xl border p-3 ${
                    phase.status === 'done' ? 'border-emerald-200 bg-emerald-50' : phase.status === 'in_progress' ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-slate-50'
                  }`}
                >
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-slate-700">{PHASE_LABELS_AR[code]}</span>
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                          phase.status === 'done' ? 'bg-emerald-600 text-white' : phase.status === 'in_progress' ? 'bg-amber-500 text-white' : 'bg-slate-300 text-slate-700'
                        }`}
                      >
                        {PHASE_STATUS_LABELS_AR[phase.status]}
                      </span>
                      {phase.status !== 'done' && (
                        <button
                          type="button"
                          onClick={() => updatePhase(code, { status: 'done' })}
                          className="rounded-lg bg-slate-800 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-slate-700"
                        >
                          تمييز كمكتمل
                        </button>
                      )}
                    </div>
                  </div>
                  <textarea
                    value={notesValue}
                    onChange={(e) => setPhaseNotesDraft((prev) => ({ ...prev, [draftKey]: e.target.value }))}
                    onBlur={() => updatePhase(code, { notes: notesValue })}
                    placeholder="ملاحظات هذه المرحلة..."
                    rows={2}
                    className="w-full rounded-lg border border-slate-200 bg-white p-2 text-xs"
                  />
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-2xl bg-white p-4 shadow-sm">
          <h3 className="mb-1 text-sm font-semibold text-slate-700">فريق العمل</h3>
          <p className="mb-3 text-xs text-slate-500">أعضاء الفريق متعدد التخصصات المشكَّل في مرحلة Organize.</p>
          <div className="mb-3 space-y-2">
            {detail.team.length === 0 && <p className="text-xs text-slate-400">لا يوجد أعضاء بعد.</p>}
            {detail.team.map((m) => (
              <div key={m.id} className="flex items-center justify-between rounded-xl border border-slate-100 p-2.5">
                <div>
                  <p className="text-sm font-semibold text-slate-700">{m.user_full_name ?? m.name}</p>
                  {m.role_label && <p className="text-xs text-slate-400">{m.role_label}</p>}
                </div>
                <button type="button" onClick={() => removeMember(m.id)} className="text-xs text-red-600 hover:underline">
                  إزالة
                </button>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              value={newMemberName}
              onChange={(e) => setNewMemberName(e.target.value)}
              placeholder="اسم العضو"
              className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <input
              value={newMemberRole}
              onChange={(e) => setNewMemberRole(e.target.value)}
              placeholder="الدور (مثلاً: قائد الفريق)"
              className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <button type="button" onClick={addMember} className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700">
              إضافة عضو
            </button>
          </div>
        </div>

        <div className="rounded-2xl bg-white p-4 shadow-sm">
          <h3 className="mb-1 text-sm font-semibold text-slate-700">دورات Plan-Do-Check-Act</h3>
          <p className="mb-3 text-xs text-slate-500">قد يتكرر تنفيذ الدورة أكثر من مرة حتى يثبت التحسين — كل دورة توثّق مؤشرها ونتيجته قبل/بعد.</p>
          <div className="space-y-3">
            {detail.cycles.map((c) => {
              const draft = cycleDrafts[c.id] ?? {};
              const field = (key: keyof QiCycle) => (draft[key] as string | undefined) ?? (c[key] as string | null) ?? '';
              const setField = (key: keyof QiCycle, value: string) => setCycleDrafts((prev) => ({ ...prev, [c.id]: { ...prev[c.id], [key]: value } }));
              return (
                <div key={c.id} className="rounded-xl border border-slate-200 p-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-slate-700">
                      الدورة {c.cycle_number} {c.metric_label ? `· ${c.metric_label}` : ''}
                    </span>
                    <div className="flex items-center gap-2 text-xs text-slate-500">
                      {c.baseline_value != null && <span>قبل: {c.baseline_value}</span>}
                      <input
                        type="number"
                        step="any"
                        placeholder="النتيجة بعد"
                        defaultValue={c.result_value ?? ''}
                        onBlur={(e) => saveCycle(c.id, { result_value: e.target.value ? Number(e.target.value) : undefined })}
                        className="w-24 rounded-lg border border-slate-200 px-2 py-1 text-xs"
                      />
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${c.status === 'completed' ? 'bg-emerald-600 text-white' : 'bg-slate-300 text-slate-700'}`}>
                        {c.status === 'completed' ? 'مكتملة' : 'مفتوحة'}
                      </span>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {(['plan_notes', 'do_notes', 'check_notes', 'act_notes'] as const).map((key) => (
                      <div key={key}>
                        <label className="mb-1 block text-[11px] font-semibold text-slate-500">
                          {{ plan_notes: 'Plan', do_notes: 'Do', check_notes: 'Check', act_notes: 'Act' }[key]}
                        </label>
                        <textarea
                          value={field(key)}
                          onChange={(e) => setField(key, e.target.value)}
                          onBlur={() => saveCycle(c.id, { [key]: field(key) })}
                          rows={2}
                          className="w-full rounded-lg border border-slate-200 p-2 text-xs"
                        />
                      </div>
                    ))}
                  </div>
                  {c.status !== 'completed' && (
                    <button
                      type="button"
                      onClick={() => saveCycle(c.id, { status: 'completed' })}
                      className="mt-2 rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700"
                    >
                      إنهاء الدورة
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <input
              value={newCycleMetric}
              onChange={(e) => setNewCycleMetric(e.target.value)}
              placeholder="اسم المؤشر (مثلاً: Top Box % الانتظار)"
              className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <input
              value={newCycleBaseline}
              onChange={(e) => setNewCycleBaseline(e.target.value)}
              placeholder="القيمة قبل التحسين"
              type="number"
              step="any"
              className="w-40 rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <button type="button" onClick={addCycle} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">
              بدء دورة جديدة
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-800">تحسين الجودة (FOCUS-PDCA)</h2>
        <p className="text-sm text-slate-500">مشاريع تحسين هيكلية لأي عملية بالمستشفى — تسعة مراحل، فريق عمل، ودورات Plan-Do-Check-Act بمؤشرات قبل/بعد.</p>
      </div>

      <div className="rounded-2xl bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-sm font-semibold text-slate-700">مشروع تحسين جديد</h3>
        <div className="flex flex-wrap gap-2">
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="عنوان المشروع (المشكلة المراد تحسينها)"
            className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <select value={newDept} onChange={(e) => setNewDept(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
            <option value="">كل الأقسام</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name_ar}
              </option>
            ))}
          </select>
        </div>
        <textarea
          value={newProblem}
          onChange={(e) => setNewProblem(e.target.value)}
          placeholder="وصف المشكلة (مرحلة Find)..."
          rows={2}
          className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <button type="button" onClick={createProject} className="mt-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">
          إنشاء المشروع
        </button>
        {assignable.length > 0 && <p className="mt-2 text-[11px] text-slate-400">الأعضاء المتاحون للإسناد بهذا القسم: {assignable.map((u) => u.full_name).join('، ')}</p>}
      </div>

      <div className="space-y-2">
        {projects.length === 0 && <p className="text-sm text-slate-400">لا توجد مشاريع تحسين بعد.</p>}
        {projects.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setSelectedId(p.id)}
            className="block w-full rounded-2xl bg-white p-4 text-start shadow-sm transition hover:shadow-md"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-semibold text-slate-800">{p.title}</p>
                <p className="text-xs text-slate-400">
                  {p.department_name_ar ?? 'كل الأقسام'} {p.owner_name ? `· ${p.owner_name}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600">{PROJECT_STATUS_LABELS_AR[p.status] ?? p.status}</span>
                <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">{p.phases_done}/9 مراحل</span>
                {p.cycle_count > 0 && <span className="rounded-full bg-blue-50 px-2.5 py-1 text-[11px] font-semibold text-blue-700">{p.cycle_count} دورة PDCA</span>}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
