import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../AuthContext';
import { ROLE_LABELS_AR, type Role } from '../types';

const NAV_ITEMS: { to: string; label: string; roles?: Role[]; badgeKey?: 'comments' | 'cases' }[] = [
  { to: '/dashboard/reports', label: 'التقارير (PREMs)' },
  { to: '/dashboard/comments', label: 'ذكاء التعليقات', badgeKey: 'comments' },
  { to: '/dashboard/service-recovery', label: 'استعادة الخدمة', badgeKey: 'cases' },
  {
    to: '/dashboard/quality-improvement',
    label: 'تحسين الجودة (FOCUS-PDCA)',
    roles: ['SystemAdmin', 'QualityManager', 'DepartmentManager']
  },
  { to: '/dashboard/department-insights', label: 'الاستفسار عن قسم' },
  { to: '/dashboard/proms', label: 'النتائج الصحية (PROMs)' },
  { to: '/dashboard/employee-experience', label: 'تجربة الموظف', roles: ['SystemAdmin', 'QualityManager', 'ExecutiveViewer', 'DepartmentManager'] },
  { to: '/dashboard/phone-survey', label: 'استبيان هاتفي' },
  { to: '/dashboard/survey-studio', label: 'استوديو الاستبيانات', roles: ['SystemAdmin', 'QualityManager'] },
  { to: '/dashboard/data-center', label: 'مركز البيانات', roles: ['SystemAdmin', 'QualityManager'] },
  { to: '/dashboard/admin', label: 'الإدارة', roles: ['SystemAdmin'] },
  { to: '/dashboard/settings', label: 'الإعدادات', roles: ['SystemAdmin'] },
  { to: '/dashboard/security', label: 'الأمان' }
];

export default function DashboardLayout() {
  const { user, logout } = useAuth();
  const [alertSummary, setAlertSummary] = useState<{ unacknowledgedComments: number; openCases: number } | null>(null);

  useEffect(() => {
    if (!user || user.role === 'ExecutiveViewer') return;
    const load = () =>
      api
        .get<{ unacknowledgedComments: number; openCases: number }>('/alerts/summary')
        .then(setAlertSummary)
        .catch(() => undefined);
    load();
    const interval = setInterval(load, 60_000);
    return () => clearInterval(interval);
  }, [user]);

  if (!user) return null;

  const visibleItems = NAV_ITEMS.filter((item) => !item.roles || item.roles.includes(user.role));
  const badgeCount = (key?: 'comments' | 'cases') => {
    if (!alertSummary || !key) return 0;
    return key === 'comments' ? alertSummary.unacknowledgedComments : alertSummary.openCases;
  };

  return (
    <div className="flex min-h-screen bg-slate-50" dir="rtl">
      <aside className="sticky top-0 flex h-screen w-64 flex-col border-l border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-5 py-4">
          <h1 className="text-lg font-bold text-slate-800">تجربة</h1>
          <p className="text-xs text-slate-500">منصة تجربة المريض</p>
        </div>
        <nav className="flex-1 space-y-1 p-3">
          {visibleItems.map((item) => {
            const count = badgeCount(item.badgeKey);
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `flex items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition ${
                    isActive ? 'bg-emerald-50 text-emerald-700' : 'text-slate-600 hover:bg-slate-100'
                  }`
                }
              >
                <span>{item.label}</span>
                {count > 0 && (
                  <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-bold text-red-700">{count}</span>
                )}
              </NavLink>
            );
          })}
        </nav>
        <div className="border-t border-slate-200 p-4">
          <p className="text-sm font-semibold text-slate-700">{user.fullName}</p>
          <p className="mb-3 text-xs text-slate-500">{ROLE_LABELS_AR[user.role]}</p>
          <button
            type="button"
            onClick={() => logout()}
            className="w-full rounded-lg border border-slate-300 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
          >
            تسجيل الخروج
          </button>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}
