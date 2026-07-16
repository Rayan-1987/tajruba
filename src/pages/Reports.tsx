import { useEffect, useMemo, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { api } from '../api';
import { useAuth } from '../AuthContext';
import { SERVICE_LABELS_AR, type Department, type ServiceType } from '../types';

interface QuestionScore {
  id: string;
  code: string;
  text_ar: string;
  answer_type: string;
  n?: number;
  mean?: number | null;
  topBoxPercent?: number | null;
  npsScore?: number | null;
}

interface DomainReport {
  domain: { id: string; code: string; nameAr: string; nameEn: string; serviceType: ServiceType };
  score: { n: number; mean: number | null; benchmark: number | null; diff: number | null; smallSample: boolean };
  questions: QuestionScore[];
}

export default function Reports() {
  const { user } = useAuth();
  const [departments, setDepartments] = useState<Department[]>([]);
  const [serviceType, setServiceType] = useState<ServiceType | ''>('');
  const [departmentId, setDepartmentId] = useState<string>(user?.departmentId ?? '');
  const [domains, setDomains] = useState<DomainReport[]>([]);
  const [smallSampleThreshold, setSmallSampleThreshold] = useState(30);
  const [trend, setTrend] = useState<{ month: string; mean: number; n: number }[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ departments: Department[] }>('/departments').then((res) => setDepartments(res.departments));
  }, []);

  useEffect(() => {
    const params = new URLSearchParams();
    if (serviceType) params.set('serviceType', serviceType);
    if (departmentId) params.set('departmentId', departmentId);
    api.get<{ smallSampleThreshold: number; domains: DomainReport[] }>(`/reports/scores?${params}`).then((res) => {
      setDomains(res.domains);
      setSmallSampleThreshold(res.smallSampleThreshold);
    });
    api.get<{ trend: { month: string; mean: number; n: number }[] }>(`/reports/trend?${params}`).then((res) => setTrend(res.trend));
  }, [serviceType, departmentId]);

  const isDeptLocked = user?.role === 'DepartmentManager';

  const filteredDomains = useMemo(() => domains.filter((d) => d.score.n > 0), [domains]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-800">تقارير تجربة المريض (PREMs)</h2>
        <p className="text-sm text-slate-500">المتوسط، نسبة Top Box، وفرق المعيار الإقليمي لكل محور وسؤال</p>
      </div>

      <div className="flex flex-wrap gap-3">
        <select
          value={serviceType}
          onChange={(e) => setServiceType(e.target.value as ServiceType | '')}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
        >
          <option value="">كل الخدمات</option>
          {Object.entries(SERVICE_LABELS_AR).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select
          value={departmentId}
          disabled={isDeptLocked}
          onChange={(e) => setDepartmentId(e.target.value)}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-100"
        >
          <option value="">كل الأقسام</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name_ar}
            </option>
          ))}
        </select>
      </div>

      {trend.length > 0 && (
        <div className="rounded-2xl bg-white p-4 shadow-sm">
          <h3 className="mb-2 text-sm font-semibold text-slate-700">اتجاه المتوسط الشهري</h3>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={trend}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="month" tick={{ fontSize: 12 }} />
              <YAxis domain={[1, 5]} tick={{ fontSize: 12 }} />
              <Tooltip />
              <Line type="monotone" dataKey="mean" stroke="#059669" strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {filteredDomains.map((d) => {
          const diff = d.score.diff;
          const diffColor = diff == null ? 'text-slate-400' : diff >= 0 ? 'text-emerald-600' : 'text-red-600';
          return (
            <button
              key={d.domain.id}
              onClick={() => setExpanded(expanded === d.domain.id ? null : d.domain.id)}
              className="rounded-2xl bg-white p-4 text-right shadow-sm transition hover:shadow-md"
            >
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs font-medium text-slate-400">{SERVICE_LABELS_AR[d.domain.serviceType]}</span>
                {d.score.smallSample && (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                    عينة صغيرة (n&lt;{smallSampleThreshold})
                  </span>
                )}
              </div>
              <h4 className="mb-2 font-semibold text-slate-800">{d.domain.nameAr}</h4>
              <div className="flex items-end justify-between">
                <span className="text-2xl font-bold text-slate-800">{d.score.mean?.toFixed(2) ?? '-'}</span>
                <span className={`text-sm font-semibold ${diffColor}`}>
                  {diff != null ? `${diff >= 0 ? '+' : ''}${diff.toFixed(2)} عن المعيار` : ''}
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-400">n = {d.score.n}</p>

              {expanded === d.domain.id && (
                <div className="mt-3 space-y-2 border-t border-slate-100 pt-3">
                  {d.questions.map((q) => (
                    <div key={q.id} className="flex items-center justify-between text-xs">
                      <span className="text-slate-600">{q.text_ar}</span>
                      <span className="font-semibold text-slate-700">
                        {q.answer_type === 'nps' ? `NPS ${q.npsScore ?? '-'}` : `${q.mean?.toFixed(2) ?? '-'} / TB ${q.topBoxPercent ?? '-'}%`}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
