import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { ROLE_LABELS_AR, type Role } from '../types';

const NAV_ITEMS: { to: string; label: string; roles?: Role[] }[] = [
  { to: '/dashboard/reports', label: 'التقارير (PREMs)' },
  { to: '/dashboard/comments', label: 'ذكاء التعليقات' },
  { to: '/dashboard/service-recovery', label: 'استعادة الخدمة' },
  { to: '/dashboard/proms', label: 'النتائج الصحية (PROMs)' },
  { to: '/dashboard/phone-survey', label: 'استبيان هاتفي' },
  { to: '/dashboard/survey-studio', label: 'استوديو الاستبيانات', roles: ['SystemAdmin', 'QualityManager'] },
  { to: '/dashboard/data-center', label: 'مركز البيانات', roles: ['SystemAdmin', 'QualityManager'] },
  { to: '/dashboard/admin', label: 'الإدارة', roles: ['SystemAdmin'] },
  { to: '/dashboard/settings', label: 'الإعدادات', roles: ['SystemAdmin'] }
];

export default function DashboardLayout() {
  const { user, logout } = useAuth();
  if (!user) return null;

  const visibleItems = NAV_ITEMS.filter((item) => !item.roles || item.roles.includes(user.role));

  return (
    <div className="flex min-h-screen bg-slate-50" dir="rtl">
      <aside className="sticky top-0 flex h-screen w-64 flex-col border-l border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-5 py-4">
          <h1 className="text-lg font-bold text-slate-800">تجربة</h1>
          <p className="text-xs text-slate-500">منصة تجربة المريض</p>
        </div>
        <nav className="flex-1 space-y-1 p-3">
          {visibleItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `block rounded-lg px-3 py-2 text-sm font-medium transition ${
                  isActive ? 'bg-emerald-50 text-emerald-700' : 'text-slate-600 hover:bg-slate-100'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
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
