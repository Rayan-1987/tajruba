import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { CATEGORY_LABELS_AR, SENTIMENT_LABELS_AR } from '../types';
import type { Department } from '../types';

interface DomainScore {
  domainId: string;
  nameAr: string;
  n: number;
  topBoxPercent: number | null;
  benchmarkTopBoxPercent: number;
  diffPercentPoints: number | null;
  targetTopBoxPercent: number | null;
  targetStatus: 'met' | 'near' | 'below' | null;
}

interface DepartmentInsights {
  department: { id: string; nameAr: string; nameEn: string; serviceType: string };
  domainScores: DomainScore[];
  sentimentCounts: Record<string, number>;
  categoryCounts: Record<string, number>;
  commentCount: number;
  serviceRecovery: { openCases: number; overdueCases: number; escalatedCases: number };
  qiProjects: { id: string; title: string; status: string; phasesDone: number }[];
  findings: string[];
  recommendQiProject: boolean;
}

const TARGET_STATUS_COLORS: Record<string, string> = {
  met: 'bg-emerald-100 text-emerald-700',
  near: 'bg-amber-100 text-amber-700',
  below: 'bg-red-100 text-red-700'
};
const TARGET_STATUS_LABELS_AR: Record<string, string> = { met: 'محقَّق', near: 'قريب من الهدف', below: 'دون الهدف' };

export default function DepartmentInsights() {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [insights, setInsights] = useState<DepartmentInsights | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.get<{ departments: Department[] }>('/departments').then((res) => {
      setDepartments(res.departments);
      if (res.departments.length === 1) setSelectedId(res.departments[0].id);
    });
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setInsights(null);
      return;
    }
    setLoading(true);
    api
      .get<DepartmentInsights>(`/department-insights/${selectedId}`)
      .then(setInsights)
      .finally(() => setLoading(false));
  }, [selectedId]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-800">الاستفسار عن قسم</h2>
        <p className="text-sm text-slate-500">مساعد يحلل أداء أي قسم تلقائيًا: أضعف المحاور، أكثر الشكاوى تكرارًا، حالات استعادة الخدمة، ومشاريع التحسين — بدلاً من تصفح عدة شاشات.</p>
      </div>

      <div className="rounded-2xl bg-white p-4 shadow-sm">
        <label className="mb-1 block text-sm font-medium text-slate-600">اختر القسم</label>
        <select
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          className="w-full max-w-sm rounded-lg border border-slate-300 px-3 py-2 text-sm"
        >
          <option value="">— اختر —</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name_ar}
            </option>
          ))}
        </select>
      </div>

      {loading && <p className="text-sm text-slate-400">جارِ التحليل...</p>}

      {insights && (
        <>
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
            <h3 className="mb-2 text-sm font-bold text-emerald-800">ملخص الأداء — {insights.department.nameAr}</h3>
            <ul className="space-y-1.5">
              {insights.findings.map((f, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-emerald-900">
                  <span className="mt-0.5 text-emerald-500">•</span>
                  <span>{f}</span>
                </li>
              ))}
            </ul>
            {insights.recommendQiProject && (
              <Link
                to="/dashboard/quality-improvement"
                className="mt-3 inline-block rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700"
              >
                ابدأ مشروع تحسين (FOCUS-PDCA) لهذا القسم
              </Link>
            )}
          </div>

          <div className="rounded-2xl bg-white p-4 shadow-sm">
            <h3 className="mb-3 text-sm font-semibold text-slate-700">محاور تجربة المريض (آخر 3 أشهر)</h3>
            <div className="space-y-2">
              {insights.domainScores.map((d) => (
                <div key={d.domainId} className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 p-2.5">
                  <div>
                    <p className="text-sm font-semibold text-slate-700">{d.nameAr}</p>
                    <p className="text-xs text-slate-400">
                      n={d.n} {d.diffPercentPoints != null && `· ${d.diffPercentPoints >= 0 ? '+' : ''}${d.diffPercentPoints} نقطة عن المعيار`}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-lg font-bold text-slate-800">{d.topBoxPercent != null ? `${d.topBoxPercent}%` : '—'}</span>
                    {d.targetStatus && (
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${TARGET_STATUS_COLORS[d.targetStatus]}`}>
                        {TARGET_STATUS_LABELS_AR[d.targetStatus]}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="rounded-2xl bg-white p-4 shadow-sm">
              <h3 className="mb-2 text-sm font-semibold text-slate-700">التعليقات ({insights.commentCount})</h3>
              {insights.commentCount === 0 ? (
                <p className="text-xs text-slate-400">لا توجد تعليقات خلال آخر 3 أشهر.</p>
              ) : (
                <>
                  <div className="mb-2 flex flex-wrap gap-2">
                    {Object.entries(insights.sentimentCounts).map(([sentiment, count]) => (
                      <span key={sentiment} className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600">
                        {SENTIMENT_LABELS_AR[sentiment] ?? sentiment}: {count}
                      </span>
                    ))}
                  </div>
                  <div className="space-y-1">
                    {Object.entries(insights.categoryCounts)
                      .sort((a, b) => b[1] - a[1])
                      .map(([category, count]) => (
                        <div key={category} className="flex justify-between text-xs text-slate-500">
                          <span>{CATEGORY_LABELS_AR[category] ?? category}</span>
                          <span className="font-semibold">{count}</span>
                        </div>
                      ))}
                  </div>
                </>
              )}
            </div>

            <div className="rounded-2xl bg-white p-4 shadow-sm">
              <h3 className="mb-2 text-sm font-semibold text-slate-700">استعادة الخدمة ومشاريع التحسين</h3>
              <div className="mb-3 flex flex-wrap gap-2">
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600">
                  مفتوحة: {insights.serviceRecovery.openCases}
                </span>
                <span className="rounded-full bg-red-100 px-2.5 py-1 text-[11px] font-semibold text-red-700">
                  متأخرة: {insights.serviceRecovery.overdueCases}
                </span>
                <span className="rounded-full bg-orange-100 px-2.5 py-1 text-[11px] font-semibold text-orange-700">
                  مُصعَّدة: {insights.serviceRecovery.escalatedCases}
                </span>
              </div>
              {insights.qiProjects.length === 0 ? (
                <p className="text-xs text-slate-400">لا توجد مشاريع تحسين لهذا القسم.</p>
              ) : (
                <div className="space-y-1.5">
                  {insights.qiProjects.map((p) => (
                    <div key={p.id} className="flex justify-between text-xs text-slate-600">
                      <span>{p.title}</span>
                      <span className="font-semibold">{p.phasesDone}/9</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
