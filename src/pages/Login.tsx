import { useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';

export default function Login() {
  const { user, login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/dashboard" replace />;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch {
      setError('البريد الإلكتروني أو كلمة المرور غير صحيحة.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-900 px-4" dir="rtl">
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-xl">
        <h1 className="mb-1 text-2xl font-bold text-slate-800">تجربة</h1>
        <p className="mb-6 text-sm text-slate-500">منصة قياس تجربة المريض والنتائج الصحية</p>
        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-600">البريد الإلكتروني</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
              placeholder="admin@tajruba.sa"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-600">كلمة المرور</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
              placeholder="••••••••"
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <p className="text-end">
            <Link to="/forgot-password" className="text-xs font-semibold text-slate-500 hover:underline">
              نسيت كلمة المرور؟
            </Link>
          </p>
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-emerald-600 py-2.5 font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-60"
          >
            {busy ? 'جارِ الدخول...' : 'تسجيل الدخول'}
          </button>
        </form>
        <div className="mt-6 rounded-lg bg-slate-50 p-3 text-xs text-slate-500">
          <p className="mb-1 font-semibold">حسابات تجريبية:</p>
          <p>admin@tajruba.sa / Tajruba123!</p>
          <p>quality@tajruba.sa / Quality123!</p>
          <p>department@tajruba.sa / Department123!</p>
          <p>executive@tajruba.sa / Executive123!</p>
        </div>
        <p className="mt-4 text-center text-sm text-slate-500">
          مستشفى جديد؟{' '}
          <Link to="/register" className="font-semibold text-emerald-600 hover:underline">
            سجّل حساب مستشفاك
          </Link>
        </p>
      </div>
    </div>
  );
}
