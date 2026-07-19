import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../AuthContext';
import { CATEGORY_LABELS_AR, SENTIMENT_LABELS_AR, SERVICE_LABELS_AR, STATUS_LABELS_AR, type ServiceType } from '../types';

interface CommentRow {
  id: string;
  department_id: string;
  department_name_ar: string;
  service_type: ServiceType;
  provider_name: string | null;
  redacted_text: string;
  created_at: string;
  sentiment: string;
  category: string;
  severity: number;
  case_id: string | null;
  case_status: string | null;
  resolution_notes: string | null;
  alert_id: string | null;
  alert_acknowledged: number | null;
}

const SEVERITY_COLORS: Record<number, string> = {
  1: 'bg-slate-100 text-slate-600',
  2: 'bg-sky-100 text-sky-700',
  3: 'bg-amber-100 text-amber-700',
  4: 'bg-orange-100 text-orange-700',
  5: 'bg-red-100 text-red-700'
};

const NEXT_STATUS: Record<string, string> = { new: 'assigned', assigned: 'in_progress', in_progress: 'closed' };
const NO_PROVIDER_KEY = '__none__';
const NO_PROVIDER_LABEL = 'بدون مقدّم خدمة محدد';

export default function CommentsIntelligence() {
  const { user } = useAuth();
  const [comments, setComments] = useState<CommentRow[]>([]);
  const [category, setCategory] = useState('');
  const [severityMin, setSeverityMin] = useState('');
  const [unacknowledgedOnly, setUnacknowledgedOnly] = useState(false);
  const [serviceType, setServiceType] = useState('');
  const [providerName, setProviderName] = useState('');
  const [collapsedServices, setCollapsedServices] = useState<Set<string>>(new Set());

  const load = () => {
    const params = new URLSearchParams();
    if (category) params.set('category', category);
    if (severityMin) params.set('severityMin', severityMin);
    if (unacknowledgedOnly) params.set('unacknowledgedOnly', 'true');
    if (serviceType) params.set('serviceType', serviceType);
    if (providerName.trim()) params.set('providerName', providerName.trim());
    api.get<{ comments: CommentRow[] }>(`/comments?${params}`).then((res) => setComments(res.comments));
  };

  useEffect(load, [category, severityMin, unacknowledgedOnly, serviceType, providerName]);

  const acknowledge = async (comment: CommentRow) => {
    await api.post(`/comments/${comment.id}/acknowledge`, {});
    load();
  };

  const advance = async (comment: CommentRow) => {
    const status = comment.case_status ? NEXT_STATUS[comment.case_status] : 'assigned';
    if (!status) return;
    if (status === 'closed' && user?.role === 'DepartmentManager') {
      alert('إغلاق الحالة يتطلب اعتماد إدارة تجربة المريض.');
      return;
    }
    await api.patch(`/comments/${comment.id}/status`, { status });
    load();
  };

  // Grouped by service, then by provider within each service — comments carry their service
  // (via the department they were left against) and, when captured at invite time, the name of
  // the treating clinician, so quality staff can see patterns per line of care and per provider
  // rather than one long undifferentiated feed.
  const groupedByService = useMemo(() => {
    const bySvc = new Map<string, CommentRow[]>();
    for (const c of comments) {
      const list = bySvc.get(c.service_type) ?? [];
      list.push(c);
      bySvc.set(c.service_type, list);
    }
    return Array.from(bySvc.entries()).map(([svc, svcComments]) => {
      const byProvider = new Map<string, CommentRow[]>();
      for (const c of svcComments) {
        const key = c.provider_name?.trim() || NO_PROVIDER_KEY;
        const list = byProvider.get(key) ?? [];
        list.push(c);
        byProvider.set(key, list);
      }
      const providerGroups = Array.from(byProvider.entries()).sort(([a], [b]) => {
        if (a === NO_PROVIDER_KEY) return 1;
        if (b === NO_PROVIDER_KEY) return -1;
        return a.localeCompare(b, 'ar');
      });
      return { serviceType: svc, comments: svcComments, providerGroups };
    });
  }, [comments]);

  const toggleService = (svc: string) =>
    setCollapsedServices((prev) => {
      const next = new Set(prev);
      if (next.has(svc)) next.delete(svc);
      else next.add(svc);
      return next;
    });

  const renderComment = (c: CommentRow) => (
    <div key={c.id} className="rounded-2xl bg-white p-4 shadow-sm">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${SEVERITY_COLORS[c.severity]}`}>خطورة {c.severity}</span>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{CATEGORY_LABELS_AR[c.category] ?? c.category}</span>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{SENTIMENT_LABELS_AR[c.sentiment] ?? c.sentiment}</span>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">{c.department_name_ar}</span>
        {c.case_status && (
          <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-semibold text-indigo-700">{STATUS_LABELS_AR[c.case_status]}</span>
        )}
        {c.alert_id && c.alert_acknowledged === 0 && (
          <span className="rounded-full bg-red-600 px-2 py-0.5 text-xs font-semibold text-white">تنبيه غير مُطّلع عليه</span>
        )}
        <span className="ms-auto text-xs text-slate-400">{new Date(c.created_at).toLocaleDateString('ar-SA')}</span>
      </div>
      <p className="mb-3 text-sm text-slate-700">{c.redacted_text}</p>
      {c.resolution_notes && <p className="mb-2 text-xs text-slate-500">ملاحظة الحل: {c.resolution_notes}</p>}
      <div className="flex flex-wrap gap-2">
        {c.case_status && c.case_status !== 'closed' && (
          <button
            type="button"
            onClick={() => advance(c)}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
          >
            نقل إلى: {STATUS_LABELS_AR[NEXT_STATUS[c.case_status]]}
          </button>
        )}
        {c.alert_id && c.alert_acknowledged === 0 && (
          <button
            type="button"
            onClick={() => acknowledge(c)}
            className="rounded-lg border border-red-300 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50"
          >
            تم الاطلاع
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-800">ذكاء التعليقات</h2>
        <p className="text-sm text-slate-500">تحليل المشاعر والتصنيف والخطورة، مقسّمة حسب الخدمة ومقدّم الخدمة، مع خصوصية معالجة تلقائية قبل أي تحليل</p>
      </div>

      <div className="flex flex-wrap gap-3">
        <select value={category} onChange={(e) => setCategory(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
          <option value="">كل التصنيفات</option>
          {Object.entries(CATEGORY_LABELS_AR).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select value={severityMin} onChange={(e) => setSeverityMin(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
          <option value="">كل درجات الخطورة</option>
          {[1, 2, 3, 4, 5].map((v) => (
            <option key={v} value={v}>
              خطورة ≥ {v}
            </option>
          ))}
        </select>
        <select value={serviceType} onChange={(e) => setServiceType(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
          <option value="">كل الخدمات</option>
          {Object.entries(SERVICE_LABELS_AR).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <input
          value={providerName}
          onChange={(e) => setProviderName(e.target.value)}
          placeholder="بحث باسم مقدّم الخدمة..."
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <label className="flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600">
          <input type="checkbox" checked={unacknowledgedOnly} onChange={(e) => setUnacknowledgedOnly(e.target.checked)} />
          التنبيهات غير المُطّلع عليها فقط
        </label>
      </div>

      <div className="space-y-4">
        {groupedByService.map(({ serviceType: svc, comments: svcComments, providerGroups }) => {
          const collapsed = collapsedServices.has(svc);
          return (
            <div key={svc} className="rounded-2xl bg-white shadow-sm">
              <button
                type="button"
                onClick={() => toggleService(svc)}
                className="flex w-full items-center justify-between px-4 py-3 text-right"
              >
                <span className="font-semibold text-slate-800">{SERVICE_LABELS_AR[svc as ServiceType] ?? svc}</span>
                <span className="text-xs text-slate-400">
                  {svcComments.length} تعليق · {providerGroups.length} مقدّم خدمة {collapsed ? '(إظهار)' : '(إخفاء)'}
                </span>
              </button>
              {!collapsed && (
                <div className="space-y-4 border-t border-slate-100 p-4">
                  {providerGroups.map(([providerKey, providerComments]) => (
                    <div key={providerKey}>
                      <p className="mb-2 text-xs font-semibold text-slate-500">
                        {providerKey === NO_PROVIDER_KEY ? NO_PROVIDER_LABEL : providerKey}{' '}
                        <span className="font-normal text-slate-400">({providerComments.length})</span>
                      </p>
                      <div className="space-y-3">{providerComments.map(renderComment)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {comments.length === 0 && <p className="text-sm text-slate-400">لا توجد تعليقات مطابقة للفلاتر الحالية.</p>}
      </div>
    </div>
  );
}
