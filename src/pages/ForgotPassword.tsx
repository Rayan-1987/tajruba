import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/auth/forgot-password', { email });
      setSent(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-900 px-4" dir="rtl">
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-xl">
        <h1 className="mb-1 text-2xl font-bold text-slate-800">نسيت كلمة المرور؟</h1>
        <p className="mb-6 text-sm text-slate-500">أدخل بريدك الإلكتروني وسنرسل لك رابطًا لإعادة تعيين كلمة المرور.</p>
        {sent ? (
          <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-700">
            إذا كان هذا البريد مرتبطًا بحساب لديك، فستصلك رسالة تحتوي على رابط إعادة التعيين (صالح لمدة ٣٠ دقيقة).
          </p>
        ) : (
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
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-lg bg-emerald-600 py-2.5 font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-60"
            >
              {busy ? 'جارِ الإرسال...' : 'إرسال رابط إعادة التعيين'}
            </button>
          </form>
        )}
        <p className="mt-4 text-center text-sm text-slate-500">
          <Link to="/login" className="font-semibold text-emerald-600 hover:underline">
            الرجوع لتسجيل الدخول
          </Link>
        </p>
      </div>
    </div>
  );
}
