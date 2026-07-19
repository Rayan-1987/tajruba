import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { SERVICE_LABELS_AR, type ServiceType } from '../types';

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
  vsLastPeriod?: number | null;
  vs12MonthsAgo?: number | null;
}

interface DomainReport {
  domain: { id: string; code: string; nameAr: string; nameEn: string; serviceType: ServiceType };
  score: { n: number; mean: number | null; topBoxPercent: number | null; benchmarkTopBoxPercent: number | null; diffPercentPoints: number | null };
  benchmarks: { peerGroupName: string; value: number }[];
  questions: QuestionScore[];
}

interface PriorityItem {
  id: string;
  textAr: string;
  isCustom: boolean;
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
  changeVsPreviousPeriod: number | null;
  deviationVsOrgAverage: number | null;
}

interface ReportParameters {
  tenantNameAr: string | null;
  generatedAt: string;
  filters: { serviceType: string | null; departmentId: string | null; period: string | null; from: string | null; to: string | null };
  thresholds: { smallSampleThreshold: number; reliableSampleThreshold: number; publicReportingSampleThreshold: number };
  departmentsIncluded: { id: string; departmentNameAr: string; facilityNameAr: string }[];
}

/** Print-friendly, standalone report view — no sidebar/nav — meant to be exported to PDF via the
 * browser's own print dialog rather than a server-side PDF renderer. */
export default function ReportsPrint() {
  const [search] = useSearchParams();
  const serviceType = search.get('serviceType') ?? '';
  const departmentId = search.get('departmentId') ?? '';
  const period = search.get('period') ?? 'month';

  const [params, setParams] = useState<ReportParameters | null>(null);
  const [domains, setDomains] = useState<DomainReport[]>([]);
  const [priorityItems, setPriorityItems] = useState<PriorityItem[]>([]);
  const [deptBreakdown, setDeptBreakdown] = useState<DepartmentBreakdown[]>([]);

  useEffect(() => {
    const q = new URLSearchParams();
    if (serviceType) q.set('serviceType', serviceType);
    if (departmentId) q.set('departmentId', departmentId);
    q.set('period', period);
    api.get<ReportParameters>(`/reports/parameters?${q}`).then(setParams);
    api.get<{ domains: DomainReport[] }>(`/reports/scores?${q}`).then((res) => setDomains(res.domains.filter((d) => d.score.n > 0)));
    if (serviceType) {
      api.get<{ items: PriorityItem[] }>(`/reports/priority-index?${q}`).then((res) => setPriorityItems(res.items));
      api
        .get<{ departments: DepartmentBreakdown[] }>(`/reports/departments-breakdown?serviceType=${serviceType}`)
        .then((res) => setDeptBreakdown(res.departments))
        .catch(() => setDeptBreakdown([]));
    }
  }, [serviceType, departmentId, period]);

  return (
    <div dir="rtl" className="mx-auto max-w-5xl bg-white p-8 text-slate-800 print:p-0">
      <div className="mb-4 flex justify-end print:hidden">
        <button
          type="button"
          onClick={() => window.print()}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
        >
          طباعة / حفظ كـ PDF
        </button>
      </div>

      <header className="mb-6 border-b-2 border-emerald-600 pb-3">
        <h1 className="text-2xl font-bold">تقرير تجربة المريض (PREMs)</h1>
        <p className="text-sm text-slate-500">{params?.tenantNameAr ?? ''}</p>
      </header>

      {params && (
        <section className="mb-6 rounded-xl border border-slate-200 p-4 text-xs">
          <h2 className="mb-2 text-sm font-bold">معايير التقرير</h2>
          <div className="grid grid-cols-2 gap-1">
            <p>وقت التوليد: {new Date(params.generatedAt).toLocaleString('ar-SA')}</p>
            <p>الخدمة: {params.filters.serviceType ? SERVICE_LABELS_AR[params.filters.serviceType as ServiceType] : 'كل الخدمات'}</p>
            <p>الفترة: {params.filters.period ?? '-'}</p>
            <p>
              حدود موثوقية العينة: غير كافية &lt; {params.thresholds.smallSampleThreshold} · استرشادية &lt;{' '}
              {params.thresholds.reliableSampleThreshold} · موثوقة &lt; {params.thresholds.publicReportingSampleThreshold}
            </p>
          </div>
          <p className="mt-2 font-semibold">المواقع المشمولة ({params.departmentsIncluded.length}):</p>
          <p>{params.departmentsIncluded.map((d) => `${d.facilityNameAr} — ${d.departmentNameAr}`).join('، ')}</p>
        </section>
      )}

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-bold">تحليل المحاور</h2>
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b-2 border-slate-300 text-right">
              <th className="py-1">المحور</th>
              <th className="py-1">n</th>
              <th className="py-1">المتوسط</th>
              <th className="py-1">Top Box %</th>
              <th className="py-1">المعيار الداخلي</th>
              <th className="py-1">الفرق</th>
              <th className="py-1">المعايير الخارجية</th>
            </tr>
          </thead>
          <tbody>
            {domains.map((d) => (
              <tr key={d.domain.id} className="border-b border-slate-100">
                <td className="py-1 font-semibold">{d.domain.nameAr}</td>
                <td className="py-1">{d.score.n}</td>
                <td className="py-1">{d.score.mean?.toFixed(2) ?? '-'}</td>
                <td className="py-1">{d.score.topBoxPercent != null ? `${d.score.topBoxPercent.toFixed(0)}%` : '-'}</td>
                <td className="py-1">{d.score.benchmarkTopBoxPercent != null ? `${d.score.benchmarkTopBoxPercent}%` : '-'}</td>
                <td className="py-1">{d.score.diffPercentPoints != null ? d.score.diffPercentPoints.toFixed(1) : '-'}</td>
                <td className="py-1">{d.benchmarks.map((b) => `${b.peerGroupName}: ${b.value.toFixed(1)}%`).join('، ') || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-bold">تحليل الأسئلة</h2>
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b-2 border-slate-300 text-right">
              <th className="py-1">السؤال</th>
              <th className="py-1">n</th>
              <th className="py-1">المتوسط</th>
              <th className="py-1">Top Box %</th>
              <th className="py-1">مقابل الفترة السابقة</th>
              <th className="py-1">مقابل 12 شهرًا</th>
            </tr>
          </thead>
          <tbody>
            {domains.flatMap((d) => d.questions).map((q) => (
              <tr key={q.id} className="border-b border-slate-100">
                <td className="py-1">
                  {q.text_ar}
                  {q.isCustom && ' †'}
                </td>
                <td className="py-1">{q.n ?? '-'}</td>
                <td className="py-1">{q.mean?.toFixed(2) ?? '-'}</td>
                <td className="py-1">{q.cahpsItem && q.topBoxPercent != null ? `${q.topBoxPercent}%` : '-'}</td>
                <td className="py-1">{q.vsLastPeriod ?? '-'}</td>
                <td className="py-1">{q.vs12MonthsAgo ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-1 text-[10px] text-slate-400">† سؤال مخصص غير معياري. يظهر Top Box فقط لعناصر CAHPS.</p>
      </section>

      {priorityItems.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-sm font-bold">مؤشر الأولوية</h2>
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b-2 border-slate-300 text-right">
                <th className="py-1">#</th>
                <th className="py-1">السؤال</th>
                <th className="py-1">المحور</th>
                <th className="py-1">النتيجة</th>
                <th className="py-1">الارتباط</th>
              </tr>
            </thead>
            <tbody>
              {priorityItems.map((item, i) => (
                <tr key={item.id} className="border-b border-slate-100">
                  <td className="py-1">{i + 1}</td>
                  <td className="py-1">
                    {item.textAr}
                    {item.isCustom && ' †'}
                  </td>
                  <td className="py-1">{item.domainNameAr}</td>
                  <td className="py-1">{item.mean?.toFixed(1) ?? '-'}</td>
                  <td className="py-1">{item.correlation?.toFixed(2) ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {deptBreakdown.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-sm font-bold">مقارنة الأقسام</h2>
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b-2 border-slate-300 text-right">
                <th className="py-1">القسم</th>
                <th className="py-1">n</th>
                <th className="py-1">النتيجة الحالية</th>
                <th className="py-1">التغيّر</th>
                <th className="py-1">الانحراف عن المتوسط</th>
              </tr>
            </thead>
            <tbody>
              {deptBreakdown.map((dept) => (
                <tr key={dept.departmentId} className="border-b border-slate-100">
                  <td className="py-1">{dept.departmentNameAr}</td>
                  <td className="py-1">{dept.n}</td>
                  <td className="py-1">{dept.currentTopBoxPercent != null ? `${dept.currentTopBoxPercent.toFixed(0)}%` : '-'}</td>
                  <td className="py-1">{dept.changeVsPreviousPeriod ?? '-'}</td>
                  <td className="py-1">{dept.deviationVsOrgAverage ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <footer className="mt-8 border-t border-slate-200 pt-3 text-[10px] text-slate-400">
        <p>هذا التقرير آلي التوليد من منصة تجربة (Tajruba) لغرض الاستخدام الداخلي لإدارة تجربة المريض.</p>
        <p>وقت التوليد: {params ? new Date(params.generatedAt).toLocaleString('ar-SA') : '-'}</p>
      </footer>
    </div>
  );
}
