import { useEffect, useState } from 'react';
import { api } from '../api';

interface AuditLog {
  id: string;
  user_id: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  metadata_json: string | null;
  created_at: string;
}

const ACTION_LABELS_AR: Record<string, string> = {
  login: 'تسجيل دخول',
  seed_completed: 'تهيئة البيانات التجريبية',
  case_status_change: 'تغيير حالة إجراء تصحيحي',
  invitations_bulk_created: 'إنشاء دعوات استبيان بالجملة',
  episode_created: 'تسجيل حالة PROMs جديدة'
};

export default function DataCenter() {
  const [logs, setLogs] = useState<AuditLog[]>([]);

  useEffect(() => {
    api.get<{ logs: AuditLog[] }>('/audit-logs').then((res) => setLogs(res.logs));
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-800">مركز البيانات وسجل التدقيق</h2>
        <p className="text-sm text-slate-500">كل عملية حساسة داخل النظام موثّقة: من، متى، وماذا (متطلب NCA/PDPL)</p>
      </div>

      <div className="overflow-x-auto rounded-2xl bg-white p-4 shadow-sm">
        <table className="w-full min-w-[600px] text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-right text-xs text-slate-400">
              <th className="pb-2">الإجراء</th>
              <th className="pb-2">الكيان</th>
              <th className="pb-2">التفاصيل</th>
              <th className="pb-2">التاريخ</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr key={log.id} className="border-b border-slate-100">
                <td className="py-2 font-medium text-slate-700">{ACTION_LABELS_AR[log.action] ?? log.action}</td>
                <td className="py-2 text-slate-500">{log.entity}</td>
                <td className="py-2 text-xs text-slate-400">{log.metadata_json ?? '-'}</td>
                <td className="py-2 text-xs text-slate-400">{new Date(log.created_at).toLocaleString('ar-SA')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {logs.length === 0 && <p className="py-4 text-sm text-slate-400">لا يوجد سجل تدقيق بعد.</p>}
      </div>
    </div>
  );
}
