import { useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../AuthContext';

export default function Register() {
  const { user, login } = useAuth();
  const [hospitalNameAr, setHospitalNameAr] = useState('');
  const [hospitalNameEn, setHospitalNameEn] = useState('');
  const [adminFullName, setAdminFullName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/dashboard" replace />;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/tenants/register', { hospitalNameAr, hospitalNameEn, adminFullName, adminEmail, adminPassword });
      await login(adminEmail, adminPassword);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setError('البريد الإلكتروني مستخدم مسبقًا.');
      else if (err instanceof ApiError && err.status === 400) setError('يرجى تعبئة كل الحقول بشكل صحيح (كلمة المرور 8 أحرف على الأقل).');
      else setError('تعذر إنشاء الحساب، حاول مرة أخرى.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-900 px-4 py-10" dir="rtl">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-xl">
        <h1 className="mb-1 text-2xl font-bold text-slate-800">تسجيل مستشفى جديد</h1>
        <p className="mb-6 text-sm text-slate-500">كل مستشفى يحصل على بيئة بيانات مستقلة بالكامل عن أي مستشفى آخر</p>
        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-600">اسم المستشفى (عربي)</label>
            <input
              required
              value={hospitalNameAr}
              onChange={(e) => setHospitalNameAr(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
              placeholder="مستشفى الأمل التخصصي"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-600">اسم المستشفى (إنجليزي)</label>
            <input
              required
              value={hospitalNameEn}
              onChange={(e) => setHospitalNameEn(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
              placeholder="Al Amal Specialist Hospital"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-600">اسمك الكامل (مدير النظام)</label>
            <input
              required
              value={adminFullName}
              onChange={(e) => setAdminFullName(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-600">البريد الإلكتروني</label>
            <input
              type="email"
              required
              value={adminEmail}
              onChange={(e) => setAdminEmail(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-600">كلمة المرور (8 أحرف على الأقل)</label>
            <input
              type="password"
              required
              minLength={8}
              value={adminPassword}
              onChange={(e) => setAdminPassword(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-emerald-600 py-2.5 font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-60"
          >
            {busy ? 'جارِ الإنشاء...' : 'إنشاء حساب المستشفى'}
          </button>
        </form>
        <p className="mt-4 text-center text-sm text-slate-500">
          عندك حساب؟{' '}
          <Link to="/login" className="font-semibold text-emerald-600 hover:underline">
            تسجيل الدخول
          </Link>
        </p>
        <p className="mt-4 text-center text-xs text-slate-400">
          بإنشاء حساب فإنك توافق على{' '}
          <Link to="/terms" className="hover:underline">
            شروط الاستخدام
          </Link>
          {' و'}
          <Link to="/data-processing-agreement" className="hover:underline">
            اتفاقية معالجة البيانات
          </Link>
        </p>
      </div>
    </div>
  );
}
