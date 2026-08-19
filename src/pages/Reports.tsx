import { useEffect, useMemo, useState } from 'react';
import {
  LineChart,
  Line,
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  ZAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer
} from 'recharts';
import { Link } from 'react-router-dom';
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

interface Distribution {
  veryGoodPercent: number;
  goodPercent: number;
  fairPercent: number;
  poorPercent: number;
  veryPoorPercent: number;
}

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
  isCustom?: boolean;
  cahpsItem?: boolean;
  distribution?: Distribution | null;
  vsLastPeriod?: number | null;
  vs12MonthsAgo?: number | null;
}

interface ExternalBenchmark {
  peerGroupName: string;
  value: number;
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
  benchmarks: ExternalBenchmark[];
  questions: QuestionScore[];
  targetTopBoxPercent: number | null;
  targetStatus: 'met' | 'near' | 'below' | null;
}

interface PriorityItem {
  id: string;
  code: string;
  textAr: string;
  isCustom: boolean;
  cahpsItem: boolean;
  domainNameAr: string;
  n: number;
  mean: number | null;
  correlation: number | null;
}

interface DepartmentBreakdown {
  departmentId: string;
  departmentNameAr: string;
  n: number;
  currentTopBoxPercent: number | null;
  previousTopBoxPercent: number | null;
  changeVsPreviousPeriod: number | null;
  deviationVsOrgAverage: number | null;
  percentileRank: number | null;
  trend: { period: string; topBoxPercent: number; n: number }[];
}

interface MoverItem {
  id: string;
  textAr: string;
  isCustom: boolean;
  domainNameAr: string;
  n: number;
  currentValue: number | null;
  previousValue: number | null;
  change: number | null;
}

interface ReportParameters {
  tenantNameAr: string | null;
  tenantNameEn: string | null;
  generatedAt: string;
  filters: { serviceType: string | null; departmentId: string | null; period: string | null; from: string | null; to: string | null };
  thresholds: { smallSampleThreshold: number; reliableSampleThreshold: number; publicReportingSampleThreshold: number };
  departmentsIncluded: { id: string; departmentNameAr: string; facilityNameAr: string; serviceType: ServiceType }[];
}

const isAdminRole = (role: string | undefined) => role === 'SystemAdmin' || role === 'QualityManager';

export default function Reports() {
  const { user } = useAuth();
  const [departments, setDepartments] = useState<Department[]>([]);
  const [serviceType, setServiceType] = useState<ServiceType | ''>('');
  const [departmentId, setDepartmentId] = useState<string>(user?.departmentId ?? '');
  const [domains, setDomains] = useState<DomainReport[]>([]);
  const [period, setPeriod] = useState<'month' | 'quarter' | 'half' | 'year'>('month');
  const [trend, setTrend] = useState<{ period: string; mean: number; topBoxPercent: number; n: number }[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [customRange, setCustomRange] = useState(false);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [priorityItems, setPriorityItems] = useState<PriorityItem[]>([]);
  const [deptBreakdown, setDeptBreakdown] = useState<{ orgAverageTopBoxPercent: number | null; departments: DepartmentBreakdown[] }>({
    orgAverageTopBoxPercent: null,
    departments: []
  });
  const [params, setParams] = useState<ReportParameters | null>(null);
  const [paramsExpanded, setParamsExpanded] = useState(false);
  const [movers, setMovers] = useState<{ increases: MoverItem[]; declines: MoverItem[] }>({ increases: [], declines: [] });

  useEffect(() => {
    api.get<{ departments: Department[] }>('/departments').then((res) => setDepartments(res.departments));
  }, []);

  useEffect(() => {
    const scoreParams = new URLSearchParams();
    if (serviceType) scoreParams.set('serviceType', serviceType);
    if (departmentId) scoreParams.set('departmentId', departmentId);
    api.get<{ domains: DomainReport[] }>(`/reports/scores?${scoreParams}`).then((res) => setDomains(res.domains));

    const trendParams = new URLSearchParams(scoreParams);
    if (customRange && (fromDate || toDate)) {
      if (fromDate) trendParams.set('from', new Date(fromDate).toISOString());
      if (toDate) trendParams.set('to', new Date(toDate).toISOString());
    } else {
      trendParams.set('period', period);
    }
    api
      .get<{ trend: { period: string; mean: number; topBoxPercent: number; n: number }[] }>(`/reports/trend?${trendParams}`)
      .then((res) => setTrend(res.trend));

    if (serviceType) {
      api.get<{ items: PriorityItem[] }>(`/reports/priority-index?${scoreParams}`).then((res) => setPriorityItems(res.items));
      api.get<{ increases: MoverItem[]; declines: MoverItem[] }>(`/reports/movers?${scoreParams}`).then(setMovers);
      if (user?.role !== 'DepartmentManager') {
        api
          .get<{ orgAverageTopBoxPercent: number | null; departments: DepartmentBreakdown[] }>(
            `/reports/departments-breakdown?serviceType=${serviceType}`
          )
          .then(setDeptBreakdown);
      } else {
        setDeptBreakdown({ orgAverageTopBoxPercent: null, departments: [] });
      }
    } else {
      setPriorityItems([]);
      setMovers({ increases: [], declines: [] });
      setDeptBreakdown({ orgAverageTopBoxPercent: null, departments: [] });
    }

    const paramsQuery = new URLSearchParams(scoreParams);
    if (customRange && fromDate) paramsQuery.set('from', fromDate);
    if (customRange && toDate) paramsQuery.set('to', toDate);
    if (!customRange) paramsQuery.set('period', period);
    api.get<ReportParameters>(`/reports/parameters?${paramsQuery}`).then(setParams);
  }, [serviceType, departmentId, period, customRange, fromDate, toDate, user?.role]);

  const isDeptLocked = user?.role === 'DepartmentManager';
  const filteredDomains = useMemo(() => domains.filter((d) => d.score.n > 0), [domains]);

  const printHref = useMemo(() => {
    const p = new URLSearchParams();
    if (serviceType) p.set('serviceType', serviceType);
    if (departmentId) p.set('departmentId', departmentId);
    p.set('period', period);
    return `/dashboard/reports/print?${p}`;
  }, [serviceType, departmentId, period]);

  const combinedPrintHref = useMemo(() => {
    const p = new URLSearchParams();
    p.set('services', Object.keys(SERVICE_LABELS_AR).join(','));
    p.set('period', period);
    return `/dashboard/reports/print?${p}`;
  }, [period]);

  const scoresExportHref = (format: 'csv' | 'xlsx'): string => {
    const p = new URLSearchParams();
    if (serviceType) p.set('serviceType', serviceType);
    if (departmentId) p.set('departmentId', departmentId);
    p.set('format', format);
    return `/api/reports/scores/export?${p}`;
  };

  const departmentsExportHref = (format: 'csv' | 'xlsx'): string => {
    const p = new URLSearchParams();
    if (serviceType) p.set('serviceType', serviceType);
    p.set('format', format);
    return `/api/reports/departments-breakdown/export?${p}`;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-slate-800">تقارير تجربة المريض (PREMs)</h2>
          <p className="text-sm text-slate-500">المتوسط، نسبة Top Box، وفرق المعيار الإقليمي لكل محور وسؤال</p>
        </div>
        <div className="flex gap-2">
          <Link
            to={printHref}
            target="_blank"
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            طباعة / تصدير PDF
          </Link>
          <Link
            to={combinedPrintHref}
            target="_blank"
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            تقرير شامل لكل الخدمات
          </Link>
          <a href={scoresExportHref('xlsx')} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
            تصدير Excel
          </a>
          <a href={scoresExportHref('csv')} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
            تصدير CSV
          </a>
        </div>
      </div>

      {params && (
        <div className="rounded-2xl bg-white p-4 shadow-sm">
          <button type="button" onClick={() => setParamsExpanded((v) => !v)} className="flex w-full items-center justify-between text-right">
            <span className="text-sm font-semibold text-slate-700">معايير التقرير</span>
            <span className="text-xs text-slate-400">{paramsExpanded ? 'إخفاء' : 'عرض'}</span>
          </button>
          {paramsExpanded && (
            <div className="mt-3 grid grid-cols-1 gap-2 border-t border-slate-100 pt-3 text-xs text-slate-600 md:grid-cols-2">
              <p>المنشأة: {params.tenantNameAr ?? '-'}</p>
              <p>وقت التوليد: {new Date(params.generatedAt).toLocaleString('ar-SA')}</p>
              <p>الخدمة: {params.filters.serviceType ? SERVICE_LABELS_AR[params.filters.serviceType as ServiceType] : 'كل الخدمات'}</p>
              <p>الفترة: {params.filters.period ?? '-'}</p>
              <p>
                حدود العينة: غير كافية &lt; {params.thresholds.smallSampleThreshold} · استرشادية &lt;{' '}
                {params.thresholds.reliableSampleThreshold} · موثوقة &lt; {params.thresholds.publicReportingSampleThreshold}
              </p>
              <div className="md:col-span-2">
                <p className="mb-1 font-semibold text-slate-700">المواقع المشمولة ({params.departmentsIncluded.length})</p>
                <ul className="flex flex-wrap gap-2">
                  {params.departmentsIncluded.map((d) => (
                    <li key={d.id} className="rounded-full bg-slate-100 px-2 py-0.5">
                      {d.facilityNameAr} — {d.departmentNameAr}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
      )}

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
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-700">اتجاه نسبة Top Box</h3>
          <div className="flex flex-wrap items-center gap-2">
            {!customRange && (
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
            )}
            {customRange && (
              <div className="flex items-center gap-2">
                <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1 text-xs" />
                <span className="text-xs text-slate-400">إلى</span>
                <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1 text-xs" />
              </div>
            )}
            <button
              onClick={() => setCustomRange((v) => !v)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                customRange ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              نطاق مخصص
            </button>
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
        {filteredDomains.map((d) => (
          <DomainCard key={d.domain.id} report={d} expanded={expanded === d.domain.id} onToggle={() => setExpanded(expanded === d.domain.id ? null : d.domain.id)} canEditBenchmarks={isAdminRole(user?.role)} />
        ))}
      </div>

      {serviceType && <PriorityIndexCard items={priorityItems} />}

      {serviceType && (movers.increases.length > 0 || movers.declines.length > 0) && <MoversSection movers={movers} />}

      {serviceType && user?.role !== 'DepartmentManager' && (
        <DepartmentsBreakdownSection data={deptBreakdown} exportHref={departmentsExportHref} />
      )}
    </div>
  );
}

function DomainCard({
  report,
  expanded,
  onToggle,
  canEditBenchmarks
}: {
  report: DomainReport;
  expanded: boolean;
  onToggle: () => void;
  canEditBenchmarks: boolean;
}) {
  const d = report;
  const diff = d.score.diffPercentPoints;
  const diffColor = diff == null ? 'text-slate-400' : diff >= 0 ? 'text-emerald-600' : 'text-red-600';
  const badge = CONFIDENCE_BADGE[d.score.confidenceTier];
  const reliabilityWarning = d.score.confidenceTier === 'insufficient' || d.score.confidenceTier === 'directional';
  const targetBadge: Record<'met' | 'near' | 'below', { label: string; className: string }> = {
    met: { label: 'محقَّق', className: 'bg-emerald-100 text-emerald-700' },
    near: { label: 'قريب من المستهدف', className: 'bg-amber-100 text-amber-700' },
    below: { label: 'دون المستهدف', className: 'bg-red-100 text-red-700' }
  };

  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm transition hover:shadow-md">
      <button type="button" onClick={onToggle} className="w-full text-right">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-medium text-slate-400">{SERVICE_LABELS_AR[d.domain.serviceType]}</span>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${badge.className}`}>{badge.label}</span>
        </div>
        <h4 className="mb-2 font-semibold text-slate-800">{d.domain.nameAr}</h4>
        <div className="flex items-end justify-between">
          <span className="text-2xl font-bold text-slate-800">{d.score.topBoxPercent != null ? `${d.score.topBoxPercent.toFixed(0)}%` : '-'}</span>
          <span className={`text-sm font-semibold ${diffColor}`}>
            {diff != null ? `${diff >= 0 ? '+' : ''}${diff.toFixed(1)} نقطة عن المعيار الداخلي` : ''}
          </span>
        </div>
        <p className="mt-1 text-xs text-slate-400">
          متوسط {d.score.mean?.toFixed(2) ?? '-'} من 5 · n = {d.score.n}
        </p>
        {d.targetTopBoxPercent != null && (
          <div className="mt-1.5 flex items-center gap-1.5">
            <span className="text-[10px] text-slate-400">المستهدف {d.targetTopBoxPercent}%</span>
            {d.targetStatus && (
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${targetBadge[d.targetStatus].className}`}>
                {targetBadge[d.targetStatus].label}
              </span>
            )}
          </div>
        )}
        {reliabilityWarning && (
          <p className="mt-1 text-[10px] text-red-600">* قد لا تكون النتيجة موثوقة بسبب حجم العينة (n = {d.score.n})</p>
        )}
      </button>

      {d.benchmarks.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2 border-t border-slate-100 pt-2">
          {d.benchmarks.map((b) => (
            <span key={b.peerGroupName} className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">
              {b.peerGroupName}: {b.value.toFixed(1)}%
            </span>
          ))}
        </div>
      )}

      {expanded && (
        <div className="mt-3 space-y-3 border-t border-slate-100 pt-3">
          {d.questions.map((q) => (
            <div key={q.id} className="text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-600">
                  {q.text_ar}
                  {q.isCustom && <span title="سؤال مخصص، غير معياري"> †</span>}
                </span>
                <span className="shrink-0 font-semibold text-slate-700">
                  {q.answer_type === 'nps'
                    ? `NPS ${q.npsScore ?? '-'}`
                    : q.answer_type === 'yesno'
                      ? `نعم ${q.yesPercent ?? '-'}%`
                      : q.cahpsItem
                        ? `${q.mean?.toFixed(2) ?? '-'} / TB ${q.topBoxPercent ?? '-'}%`
                        : `${q.mean?.toFixed(2) ?? '-'}`}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-3 text-[10px] text-slate-400">
                {q.vsLastPeriod != null && (
                  <span className={q.vsLastPeriod >= 0 ? 'text-emerald-600' : 'text-red-600'}>
                    مقابل الفترة السابقة: {q.vsLastPeriod >= 0 ? '+' : ''}
                    {q.vsLastPeriod}
                  </span>
                )}
                {q.vs12MonthsAgo != null && (
                  <span className={q.vs12MonthsAgo >= 0 ? 'text-emerald-600' : 'text-red-600'}>
                    مقابل قبل 12 شهرًا: {q.vs12MonthsAgo >= 0 ? '+' : ''}
                    {q.vs12MonthsAgo}
                  </span>
                )}
              </div>
              {q.distribution && (
                <div className="mt-1 flex h-2 overflow-hidden rounded-full bg-slate-100" title="ممتاز/جيد/متوسط/ضعيف/ضعيف جدًا">
                  <div style={{ width: `${q.distribution.veryGoodPercent}%` }} className="bg-emerald-600" />
                  <div style={{ width: `${q.distribution.goodPercent}%` }} className="bg-emerald-300" />
                  <div style={{ width: `${q.distribution.fairPercent}%` }} className="bg-amber-300" />
                  <div style={{ width: `${q.distribution.poorPercent}%` }} className="bg-orange-400" />
                  <div style={{ width: `${q.distribution.veryPoorPercent}%` }} className="bg-red-500" />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {canEditBenchmarks && expanded && <BenchmarkEditor domainId={d.domain.id} existing={d.benchmarks} />}
    </div>
  );
}

function BenchmarkEditor({ domainId, existing }: { domainId: string; existing: ExternalBenchmark[] }) {
  const [peerGroupName, setPeerGroupName] = useState('');
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState(false);

  const save = async () => {
    if (!peerGroupName || !value) return;
    await api.post('/reports/benchmarks', { domainId, peerGroupName, value: Number(value) });
    setPeerGroupName('');
    setValue('');
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div onClick={(e) => e.stopPropagation()} className="mt-3 border-t border-dashed border-slate-200 pt-3">
      <p className="mb-1 text-[10px] font-semibold text-slate-500">
        إدارة المعايير المرجعية الخارجية (يُدخلها المشرف يدويًا؛ لا يوجد تكامل مباشر مع قاعدة بيانات مقارنة خارجية)
      </p>
      <div className="flex flex-wrap gap-2">
        <input
          value={peerGroupName}
          onChange={(e) => setPeerGroupName(e.target.value)}
          placeholder="اسم المجموعة المرجعية (مثال: GCC)"
          className="w-40 rounded border border-slate-300 px-2 py-1 text-[10px]"
        />
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          type="number"
          placeholder="القيمة %"
          className="w-20 rounded border border-slate-300 px-2 py-1 text-[10px]"
        />
        <button type="button" onClick={save} className="rounded bg-emerald-600 px-2 py-1 text-[10px] font-semibold text-white hover:bg-emerald-700">
          حفظ
        </button>
        {saved && <span className="text-[10px] text-emerald-600">تم الحفظ</span>}
      </div>
      {existing.length === 0 && <p className="mt-1 text-[10px] text-slate-400">لا توجد معايير مرجعية بعد لهذا المحور.</p>}
    </div>
  );
}

function PriorityIndexCard({ items }: { items: PriorityItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm">
      <h3 className="mb-1 text-sm font-semibold text-slate-700">مؤشر الأولوية (Priority Index)</h3>
      <p className="mb-3 text-xs text-slate-500">الأسئلة الأكثر ارتباطًا بالتقييم العام، مرتبة تنازليًا — أولوية عالية للتحسين عند انخفاض نتيجتها</p>
      <div className="overflow-x-auto">
        <table className="w-full text-right text-xs">
          <thead>
            <tr className="border-b border-slate-100 text-slate-400">
              <th className="py-1 pe-2 font-medium">#</th>
              <th className="py-1 pe-2 font-medium">السؤال</th>
              <th className="py-1 pe-2 font-medium">المحور</th>
              <th className="py-1 pe-2 font-medium">النتيجة</th>
              <th className="py-1 font-medium">الارتباط</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => (
              <tr key={item.id} className="border-b border-slate-50">
                <td className="py-1.5 pe-2 text-slate-400">{index + 1}</td>
                <td className="py-1.5 pe-2 text-slate-700">
                  {item.textAr}
                  {item.isCustom && ' †'}
                </td>
                <td className="py-1.5 pe-2 text-slate-500">{item.domainNameAr}</td>
                <td className="py-1.5 pe-2 font-semibold text-slate-700">{item.mean != null ? item.mean.toFixed(1) : '-'}</td>
                <td className="py-1.5 font-semibold text-slate-700">{item.correlation != null ? item.correlation.toFixed(2) : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MoverRow({ item }: { item: MoverItem }) {
  return (
    <tr className="border-b border-slate-50">
      <td className="py-1.5 pe-2 text-slate-700">
        {item.textAr}
        {item.isCustom && ' †'}
      </td>
      <td className="py-1.5 pe-2 text-slate-500">{item.domainNameAr}</td>
      <td className="py-1.5 pe-2 text-slate-500">{item.n}</td>
      <td className="py-1.5 pe-2 text-slate-700">{item.currentValue?.toFixed(1) ?? '-'}</td>
      <td className={`py-1.5 font-semibold ${(item.change ?? 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
        {item.change != null ? `${item.change >= 0 ? '+' : ''}${item.change}` : '-'}
      </td>
    </tr>
  );
}

function MoversSection({ movers }: { movers: { increases: MoverItem[]; declines: MoverItem[] } }) {
  const header = (
    <tr className="border-b border-slate-100 text-slate-400">
      <th className="py-1 pe-2 font-medium">السؤال</th>
      <th className="py-1 pe-2 font-medium">المحور</th>
      <th className="py-1 pe-2 font-medium">n</th>
      <th className="py-1 pe-2 font-medium">النتيجة الحالية</th>
      <th className="py-1 font-medium">التغيّر مقابل الفترة السابقة</th>
    </tr>
  );
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <div className="rounded-2xl bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-sm font-semibold text-emerald-700">أكبر التحسّنات</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead>{header}</thead>
            <tbody>
              {movers.increases.map((item) => (
                <MoverRow key={item.id} item={item} />
              ))}
            </tbody>
          </table>
          {movers.increases.length === 0 && <p className="py-3 text-center text-slate-400">لا توجد بيانات كافية</p>}
        </div>
      </div>
      <div className="rounded-2xl bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-sm font-semibold text-red-700">أكبر التراجعات</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead>{header}</thead>
            <tbody>
              {movers.declines.map((item) => (
                <MoverRow key={item.id} item={item} />
              ))}
            </tbody>
          </table>
          {movers.declines.length === 0 && <p className="py-3 text-center text-slate-400">لا توجد بيانات كافية</p>}
        </div>
      </div>
    </div>
  );
}

function DepartmentsBreakdownSection({
  data,
  exportHref
}: {
  data: { orgAverageTopBoxPercent: number | null; departments: DepartmentBreakdown[] };
  exportHref: (format: 'csv' | 'xlsx') => string;
}) {
  if (data.departments.length === 0) return null;
  const scatterData = data.departments.filter((d) => d.changeVsPreviousPeriod != null && d.deviationVsOrgAverage != null);

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-sm font-semibold text-slate-700">مقارنة الأقسام — خريطة الأولويات</h3>
        {scatterData.length > 0 ? (
          <ResponsiveContainer width="100%" height={280}>
            <ScatterChart margin={{ top: 10, right: 20, bottom: 10, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis type="number" dataKey="changeVsPreviousPeriod" name="التغيّر مقابل الفترة السابقة" tick={{ fontSize: 11 }} />
              <YAxis type="number" dataKey="deviationVsOrgAverage" name="الانحراف عن متوسط المنشأة" tick={{ fontSize: 11 }} />
              <ZAxis type="number" dataKey="n" range={[60, 400]} name="حجم العينة" />
              <ReferenceLine x={0} stroke="#94a3b8" />
              <ReferenceLine y={0} stroke="#94a3b8" />
              <Tooltip
                cursor={{ strokeDasharray: '3 3' }}
                content={({ payload }) => {
                  if (!payload || payload.length === 0) return null;
                  const p = payload[0].payload as DepartmentBreakdown;
                  return (
                    <div className="rounded-lg bg-white p-2 text-xs shadow">
                      <p className="font-semibold text-slate-700">{p.departmentNameAr}</p>
                      <p className="text-slate-500">n = {p.n}</p>
                      <p className="text-slate-500">التغيّر: {p.changeVsPreviousPeriod}</p>
                      <p className="text-slate-500">الانحراف: {p.deviationVsOrgAverage}</p>
                    </div>
                  );
                }}
              />
              <Scatter data={scatterData} fill="#059669" />
            </ScatterChart>
          </ResponsiveContainer>
        ) : (
          <p className="py-6 text-center text-sm text-slate-400">لا توجد بيانات كافية للمقارنة بعد</p>
        )}
      </div>

      <div className="rounded-2xl bg-white p-4 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-700">
            مقارنة الأقسام — تفصيلي {data.orgAverageTopBoxPercent != null && `(متوسط المنشأة: ${data.orgAverageTopBoxPercent.toFixed(1)}%)`}
          </h3>
          <div className="flex gap-2">
            <a href={exportHref('xlsx')} className="text-xs font-semibold text-emerald-600 hover:underline">
              تصدير Excel
            </a>
            <a href={exportHref('csv')} className="text-xs font-semibold text-emerald-600 hover:underline">
              تصدير CSV
            </a>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead>
              <tr className="border-b border-slate-100 text-slate-400">
                <th className="py-1 pe-2 font-medium">القسم</th>
                <th className="py-1 pe-2 font-medium">n</th>
                <th className="py-1 pe-2 font-medium">النتيجة الحالية</th>
                <th className="py-1 pe-2 font-medium">التغيّر</th>
                <th className="py-1 pe-2 font-medium">الانحراف عن المتوسط</th>
                <th className="py-1 pe-2 font-medium" title="الترتيب المئوي بين أقسام هذه الخدمة داخل المنشأة فقط، وليس مقابل بيانات خارجية">
                  الترتيب المئوي الداخلي
                </th>
                <th className="py-1 font-medium">الاتجاه</th>
              </tr>
            </thead>
            <tbody>
              {data.departments.map((dept) => (
                <tr key={dept.departmentId} className="border-b border-slate-50">
                  <td className="py-1.5 pe-2 text-slate-700">{dept.departmentNameAr}</td>
                  <td className="py-1.5 pe-2 text-slate-500">{dept.n}</td>
                  <td className="py-1.5 pe-2 font-semibold text-slate-700">
                    {dept.currentTopBoxPercent != null ? `${dept.currentTopBoxPercent.toFixed(0)}%` : '-'}
                  </td>
                  <td className={`py-1.5 pe-2 font-semibold ${(dept.changeVsPreviousPeriod ?? 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {dept.changeVsPreviousPeriod != null ? `${dept.changeVsPreviousPeriod >= 0 ? '+' : ''}${dept.changeVsPreviousPeriod}` : '-'}
                  </td>
                  <td className={`py-1.5 pe-2 font-semibold ${(dept.deviationVsOrgAverage ?? 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {dept.deviationVsOrgAverage != null ? `${dept.deviationVsOrgAverage >= 0 ? '+' : ''}${dept.deviationVsOrgAverage}` : '-'}
                  </td>
                  <td className="py-1.5 pe-2 text-slate-500">{dept.percentileRank != null ? `%${dept.percentileRank.toFixed(0)}` : '-'}</td>
                  <td className="py-1.5">
                    <MiniSparkline points={dept.trend.map((t) => t.topBoxPercent)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function MiniSparkline({ points }: { points: number[] }) {
  if (points.length < 2) return <span className="text-slate-300">-</span>;
  const width = 80;
  const height = 24;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const step = width / (points.length - 1);
  const coords = points.map((p, i) => `${(i * step).toFixed(1)},${(height - ((p - min) / range) * height).toFixed(1)}`).join(' ');
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <polyline points={coords} fill="none" stroke="#059669" strokeWidth={1.5} />
    </svg>
  );
}
