import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../AuthContext';
import { CATEGORY_LABELS_AR, SENTIMENT_LABELS_AR, STATUS_LABELS_AR } from '../types';

interface CommentRow {
  id: string;
  department_id: string;
  redacted_text: string;
  created_at: string;
  sentiment: string;
  category: string;
  severity: number;
  case_id: string | null;
  case_status: string | null;
  resolution_notes: string | null;
}

const SEVERITY_COLORS: Record<number, string> = {
  1: 'bg-slate-100 text-slate-600',
  2: 'bg-sky-100 text-sky-700',
  3: 'bg-amber-100 text-amber-700',
  4: 'bg-orange-100 text-orange-700',
  5: 'bg-red-100 text-red-700'
};

const NEXT_STATUS: Record<string, string> = { new: 'assigned', assigned: 'in_progress', in_progress: 'closed' };

export default function CommentsIntelligence() {
  const { user } = useAuth();
  const [comments, setComments] = useState<CommentRow[]>([]);
  const [category, setCategory] = useState('');
  const [severityMin, setSeverityMin] = useState('');

  const load = () => {
    const params = new URLSearchParams();
    if (category) params.set('category', category);
    if (severityMin) params.set('severityMin', severityMin);
    api.get<{ comments: CommentRow[] }>(`/comments?${params}`).then((res) => setComments(res.comments));
  };

  useEffect(load, [category, severityMin]);

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

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-800">ذكاء التعليقات</h2>
        <p className="text-sm text-slate-500">تحليل المشاعر والتصنيف والخطورة، مع خصوصية معالجة تلقائية قبل أي تحليل</p>
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
      </div>

      <div className="space-y-3">
        {comments.map((c) => (
          <div key={c.id} className="rounded-2xl bg-white p-4 shadow-sm">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${SEVERITY_COLORS[c.severity]}`}>خطورة {c.severity}</span>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{CATEGORY_LABELS_AR[c.category] ?? c.category}</span>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{SENTIMENT_LABELS_AR[c.sentiment] ?? c.sentiment}</span>
              {c.case_status && (
                <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-semibold text-indigo-700">
                  {STATUS_LABELS_AR[c.case_status]}
                </span>
              )}
              <span className="ms-auto text-xs text-slate-400">{new Date(c.created_at).toLocaleDateString('ar-SA')}</span>
            </div>
            <p className="mb-3 text-sm text-slate-700">{c.redacted_text}</p>
            {c.resolution_notes && <p className="mb-2 text-xs text-slate-500">ملاحظة الحل: {c.resolution_notes}</p>}
            {c.case_status && c.case_status !== 'closed' && (
              <button
                type="button"
                onClick={() => advance(c)}
                className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
              >
                نقل إلى: {STATUS_LABELS_AR[NEXT_STATUS[c.case_status]]}
              </button>
            )}
          </div>
        ))}
        {comments.length === 0 && <p className="text-sm text-slate-400">لا توجد تعليقات مطابقة للفلاتر الحالية.</p>}
      </div>
    </div>
  );
}
