import { useEffect, useMemo, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { api } from '../api';
import { useAuth } from '../AuthContext';
import { SERVICE_LABELS_AR, type Department, type ServiceType } from '../types';

type ConfidenceTier = 'insufficient' | 'directional' | 'reliable' | 'public_reporting';

const CONFIDENCE_BADGE: Record<ConfidenceTier, { label: string; className: string }> = {
  insufficient: { label: 'عينة غير كافية', className: 'bg-red-100 text-red-700' },
  directional: { label: 'استرشادية', className: 'bg-amber-100 text-amber-700' },
  reliable: { label: 'موثوقة', className: 'bg-blue-100 text-blue-700' },
  public_reporting: { label: 'جاهزة للنشر', className: 'bg-emerald-100 text-emerald-700' }
};

const PERIOD_OPTIONS: { value: 'month' | 'quarter' | 'half' | 'year'; label: string }[] = [
  { value: 'month', label: 'شهري' },
  { value: 'quarter', label: 'ربع سنوي' },
  { value: 'half', label: 'نصف سنوي' },
  { value: 'year', label: 'سنوي' }
];

interface QuestionScore {
  id: string;
  code: string;
  text_ar: string;
  answer_type: string;
  n?: number;
  mean?: number | null;
  topBoxPercent?: number | null;
  npsScore?: number | null;
  yesPercent?: number | null;
}

interface DomainReport {
  domain: { id: string; code: string; nameAr: string; nameEn: string; serviceType: ServiceType };
  score: {
    n: number;
    mean: number | null;
    topBoxPercent: number | null;
    benchmarkTopBoxPercent: number | null;
    diffPercentPoints: number | null;
    confidenceTier: ConfidenceTier;
    smallSample: boolean;
  };
  questions: QuestionScore[];
}

export default function Reports() {
  const { user } = useAuth();
  const [departments, setDepartments] = useState<Department[]>([]);
  const [serviceType, setServiceType] = useState<ServiceType | ''>('');
  const [departmentId, setDepartmentId] = useState<string>(user?.departmentId ?? '');
  const [domains, setDomains] = useState<DomainReport[]>([]);
  const [period, setPeriod] = useState<'month' | 'quarter' | 'half' | 'year'>('month');
  const [trend, setTrend] = useState<{ period: string; mean: number; topBoxPercent: number; n: number }[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ departments: Department[] }>('/departments').then((res) => setDepartments(res.departments));
  }, []);

  useEffect(() => {
    const scoreParams = new URLSearchParams();
    if (serviceType) scoreParams.set('serviceType', serviceType);
    if (departmentId) scoreParams.set('departmentId', departmentId);
    api.get<{ domains: DomainReport[] }>(`/reports/scores?${scoreParams}`).then((res) => {
      setDomains(res.domains);
    });

    const trendParams = new URLSearchParams(scoreParams);
    trendParams.set('period', period);
    api
      .get<{ trend: { period: string; mean: number; topBoxPercent: number; n: number }[] }>(`/reports/trend?${trendParams}`)
      .then((res) => setTrend(res.trend));
  }, [serviceType, departmentId, period]);

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

      <div className="rounded-2xl bg-white p-4 shadow-sm">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-700">اتجاه نسبة Top Box</h3>
          <div className="flex gap-1">
            {PERIOD_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setPeriod(opt.value)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                  period === opt.value ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        {trend.length > 0 ? (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={trend}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="period" tick={{ fontSize: 12 }} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 12 }} />
              <Tooltip />
              <Line type="monotone" dataKey="topBoxPercent" name="Top Box %" stroke="#059669" strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <p className="py-6 text-center text-sm text-slate-400">لا توجد بيانات كافية لهذه الفترة</p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {filteredDomains.map((d) => {
          const diff = d.score.diffPercentPoints;
          const diffColor = diff == null ? 'text-slate-400' : diff >= 0 ? 'text-emerald-600' : 'text-red-600';
          const badge = CONFIDENCE_BADGE[d.score.confidenceTier];
          return (
            <button
              key={d.domain.id}
              onClick={() => setExpanded(expanded === d.domain.id ? null : d.domain.id)}
              className="rounded-2xl bg-white p-4 text-right shadow-sm transition hover:shadow-md"
            >
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs font-medium text-slate-400">{SERVICE_LABELS_AR[d.domain.serviceType]}</span>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${badge.className}`}>{badge.label}</span>
              </div>
              <h4 className="mb-2 font-semibold text-slate-800">{d.domain.nameAr}</h4>
              <div className="flex items-end justify-between">
                <span className="text-2xl font-bold text-slate-800">
                  {d.score.topBoxPercent != null ? `${d.score.topBoxPercent.toFixed(0)}%` : '-'}
                </span>
                <span className={`text-sm font-semibold ${diffColor}`}>
                  {diff != null ? `${diff >= 0 ? '+' : ''}${diff.toFixed(1)} نقطة عن المعيار` : ''}
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-400">
                متوسط {d.score.mean?.toFixed(2) ?? '-'} من 5 · n = {d.score.n}
              </p>

              {expanded === d.domain.id && (
                <div className="mt-3 space-y-2 border-t border-slate-100 pt-3">
                  {d.questions.map((q) => (
                    <div key={q.id} className="flex items-center justify-between text-xs">
                      <span className="text-slate-600">{q.text_ar}</span>
                      <span className="font-semibold text-slate-700">
                        {q.answer_type === 'nps'
                          ? `NPS ${q.npsScore ?? '-'}`
                          : q.answer_type === 'yesno'
                            ? `نعم ${q.yesPercent ?? '-'}%`
                            : `${q.mean?.toFixed(2) ?? '-'} / TB ${q.topBoxPercent ?? '-'}%`}
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
