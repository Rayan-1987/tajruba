import { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { api } from '../api';
import type { Department } from '../types';

interface Pathway {
  id: string;
  code: string;
  name_ar: string;
  timepoints: { id: string; code: string; name_ar: string; offset_days: number }[];
}

interface EpisodeScore {
  timepoint_code: string;
  timepoint_name: string;
  raw_score: number;
  band: string | null;
  baseline_score: number | null;
  delta: number | null;
  mcid_met: number | null;
}

interface Episode {
  id: string;
  patient_ref_hash: string;
  surgeon_ref: string | null;
  start_date: string;
  status: string;
  scores: EpisodeScore[];
}

interface Instrument {
  id: string;
  code: string;
  name_ar: string;
  license_status: 'free' | 'licensed_required';
  description_ar: string;
}

interface DueAssignment {
  id: string;
  due_date: string;
  status: string;
  episode_id: string;
  contact_phone: string | null;
  surgeon_ref: string | null;
  timepoint_name_ar: string;
  instrument_name_ar: string;
  license_status: 'free' | 'licensed_required';
  pathway_name_ar: string;
}

export default function PromsMonitor() {
  const [pathways, setPathways] = useState<Pathway[]>([]);
  const [pathwayId, setPathwayId] = useState('');
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [mcidSummary, setMcidSummary] = useState<{ timepoint: string; total: number; mcidMetPercent: number | null }[]>([]);
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [dueRefreshKey, setDueRefreshKey] = useState(0);

  useEffect(() => {
    api.get<{ pathways: Pathway[] }>('/proms/pathways').then((res) => {
      setPathways(res.pathways);
      if (res.pathways.length > 0) setPathwayId(res.pathways[0].id);
    });
    api.get<{ instruments: Instrument[] }>('/proms/instruments').then((res) => setInstruments(res.instruments));
    api.get<{ departments: Department[] }>('/departments').then((res) => setDepartments(res.departments));
  }, []);

  const loadOutcomes = () => {
    if (!pathwayId) return;
    api
      .get<{ episodes: Episode[]; mcidSummary: { timepoint: string; total: number; mcidMetPercent: number | null }[] }>(
        `/proms/outcomes?pathwayId=${pathwayId}`
      )
      .then((res) => {
        setEpisodes(res.episodes);
        setMcidSummary(res.mcidSummary);
      });
  };
  useEffect(loadOutcomes, [pathwayId]);

  const pathway = pathways.find((p) => p.id === pathwayId);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-800">النتائج الصحية المبلغة من المريض (PROMs)</h2>
        <p className="text-sm text-slate-500">قياس طولي عبر مسار الرعاية، مع نسبة تجاوز الحد السريري MCID</p>
      </div>

      <CreateEpisodeForm
        pathways={pathways}
        departments={departments}
        onCreated={() => {
          loadOutcomes();
          setDueRefreshKey((k) => k + 1);
        }}
      />
      <DueAssignmentsPanel refreshKey={dueRefreshKey} />

      <select value={pathwayId} onChange={(e) => setPathwayId(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
        {pathways.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name_ar}
          </option>
        ))}
      </select>

      {mcidSummary.length > 0 && (
        <div className="rounded-2xl bg-white p-4 shadow-sm">
          <h3 className="mb-2 text-sm font-semibold text-slate-700">% المرضى المتجاوزين للحد السريري MCID لكل نقطة قياس</h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={mcidSummary}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="timepoint" tick={{ fontSize: 12 }} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 12 }} />
              <Tooltip />
              <Bar dataKey="mcidMetPercent" fill="#059669" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="overflow-x-auto rounded-2xl bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-sm font-semibold text-slate-700">حالات المرضى - {pathway?.name_ar}</h3>
        <table className="w-full min-w-[600px] text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-right text-xs text-slate-400">
              <th className="pb-2">الجرّاح</th>
              <th className="pb-2">تاريخ البدء</th>
              {pathway?.timepoints.map((tp) => (
                <th key={tp.id} className="pb-2">
                  {tp.name_ar}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {episodes.map((ep) => (
              <tr key={ep.id} className="border-b border-slate-100">
                <td className="py-2 text-slate-600">{ep.surgeon_ref ?? '-'}</td>
                <td className="py-2 text-slate-500">{new Date(ep.start_date).toLocaleDateString('ar-SA')}</td>
                {pathway?.timepoints.map((tp) => {
                  const score = ep.scores.find((s) => s.timepoint_code === tp.code);
                  if (!score) return <td key={tp.id} className="py-2 text-slate-300">-</td>;
                  return (
                    <td key={tp.id} className="py-2">
                      <span className="font-semibold text-slate-700">{score.raw_score}</span>
                      {score.delta != null && (
                        <span className={`ms-1 text-xs ${score.mcid_met ? 'text-emerald-600' : 'text-slate-400'}`}>
                          (Δ{score.delta} {score.mcid_met ? '✓' : ''})
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {instruments.map((i) => (
          <div key={i.id} className="rounded-2xl bg-white p-4 shadow-sm">
            <div className="mb-1 flex items-center justify-between">
              <h4 className="font-semibold text-slate-800">{i.name_ar}</h4>
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                  i.license_status === 'free' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'
                }`}
              >
                {i.license_status === 'free' ? 'مجاني' : 'يتطلب ترخيص'}
              </span>
            </div>
            <p className="text-xs text-slate-500">{i.description_ar}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function CreateEpisodeForm({
  pathways,
  departments,
  onCreated
}: {
  pathways: Pathway[];
  departments: Department[];
  onCreated: () => void;
}) {
  const [pathwayId, setPathwayId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [patientRef, setPatientRef] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [surgeonRef, setSurgeonRef] = useState('');
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [consent, setConsent] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!pathwayId || !departmentId || !patientRef || !startDate) {
      setResult('يرجى اختيار المسار والقسم وإدخال مرجع المريض وتاريخ البدء.');
      return;
    }
    if (contactPhone && !consent) {
      setResult('يلزم تأكيد موافقة المريض على المتابعة الطولية قبل إدخال رقم جواله.');
      return;
    }
    setBusy(true);
    try {
      await api.post('/episodes', {
        pathwayId,
        departmentId,
        patientRef,
        contactPhone: contactPhone || undefined,
        consent: contactPhone ? consent : undefined,
        surgeonRef: surgeonRef || undefined,
        startDate
      });
      setResult('تم إنشاء الحلقة وجدولة تكليفاتها بنجاح.');
      setPatientRef('');
      setContactPhone('');
      setConsent(false);
      setSurgeonRef('');
      onCreated();
    } catch {
      setResult('تعذر إنشاء الحلقة، حاول مرة أخرى.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm">
      <h3 className="mb-1 text-sm font-semibold text-slate-700">إنشاء حلقة رعاية جديدة (Episode)</h3>
      <p className="mb-3 text-xs text-slate-500">
        يُنشئ تلقائيًا كل التكليفات (Assignments) لكل نقطة قياس في المسار، بتاريخ استحقاق محسوب من تاريخ البدء.
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <select value={pathwayId} onChange={(e) => setPathwayId(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
          <option value="">اختر المسار</option>
          {pathways.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name_ar}
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
        <input
          type="date"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <input
          value={patientRef}
          onChange={(e) => setPatientRef(e.target.value)}
          placeholder="مرجع المريض (رقم الملف)"
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <input
          value={contactPhone}
          onChange={(e) => setContactPhone(e.target.value)}
          placeholder="رقم جوال المريض (للمتابعة الطولية)"
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <input
          value={surgeonRef}
          onChange={(e) => setSurgeonRef(e.target.value)}
          placeholder="الجرّاح / الطبيب المعالج (اختياري)"
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
      </div>
      {contactPhone && (
        <label className="mt-3 flex items-start gap-2 rounded-lg bg-amber-50 p-2.5 text-xs text-amber-800">
          <input type="checkbox" className="mt-0.5" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>
            المريض وافق على أن يتم التواصل معه برسائل نصية على مدار برنامج المتابعة (حتى ١٢ شهرًا)، مع علمه أن بإمكانه
            إيقاف الرسائل في أي وقت عبر الرابط المرفق بكل رسالة.
          </span>
        </label>
      )}
      <button
        type="button"
        onClick={submit}
        disabled={busy}
        className="mt-3 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
      >
        {busy ? 'جارِ الإنشاء...' : 'إنشاء الحلقة'}
      </button>
      {result && <p className="mt-2 text-sm text-slate-600">{result}</p>}
    </div>
  );
}

function DueAssignmentsPanel({ refreshKey }: { refreshKey: number }) {
  const [assignments, setAssignments] = useState<DueAssignment[]>([]);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [resultById, setResultById] = useState<Record<string, string>>({});

  const load = () => {
    api.get<{ assignments: DueAssignment[] }>('/proms/due-assignments').then((res) => setAssignments(res.assignments));
  };
  useEffect(load, [refreshKey]);

  const send = async (a: DueAssignment) => {
    setSendingId(a.id);
    try {
      const res = await api.post<{ ok: boolean; sent: boolean }>(`/assignments/${a.id}/send`);
      setResultById((prev) => ({ ...prev, [a.id]: res.sent ? 'تم الإرسال بنجاح' : 'تعذر إرسال الرسالة' }));
      load();
    } catch {
      setResultById((prev) => ({ ...prev, [a.id]: 'تعذر الإرسال — تحقق من رقم الجوال أو أن الأداة مجانية' }));
    } finally {
      setSendingId(null);
    }
  };

  if (assignments.length === 0) return null;

  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm">
      <h3 className="mb-1 text-sm font-semibold text-slate-700">التكليفات المستحقة ({assignments.length})</h3>
      <p className="mb-3 text-xs text-slate-500">تكليفات وصلت تاريخ استحقاقها ولم تُرسل بعد.</p>
      <div className="space-y-2">
        {assignments.map((a) => (
          <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-100 p-3">
            <div>
              <p className="text-sm font-semibold text-slate-700">
                {a.instrument_name_ar} — {a.timepoint_name_ar}
              </p>
              <p className="text-xs text-slate-400">
                {a.pathway_name_ar} · {a.surgeon_ref ?? 'بلا جرّاح محدد'} · استحق في {new Date(a.due_date).toLocaleDateString('ar-SA')}
              </p>
              {resultById[a.id] && <p className="mt-1 text-xs text-slate-500">{resultById[a.id]}</p>}
            </div>
            {a.license_status !== 'free' ? (
              <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-700">تتطلب تعبئة يدوية (أداة مرخّصة)</span>
            ) : !a.contact_phone ? (
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-500">لا يوجد رقم جوال للحلقة</span>
            ) : (
              <button
                type="button"
                onClick={() => send(a)}
                disabled={sendingId === a.id}
                className="rounded-lg bg-emerald-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
              >
                {sendingId === a.id ? 'جارِ الإرسال...' : 'إرسال'}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
