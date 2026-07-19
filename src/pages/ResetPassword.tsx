import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';

export default function ResetPassword() {
  const { token = '' } = useParams();
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (newPassword.length < 8) {
      setError('كلمة المرور يجب أن تكون ٨ أحرف على الأقل.');
      return;
    }
    if (newPassword !== confirm) {
      setError('كلمتا المرور غير متطابقتين.');
      return;
    }
    setBusy(true);
    try {
      await api.post('/auth/reset-password', { token, newPassword });
      setDone(true);
    } catch (e: unknown) {
      if (e instanceof ApiError && e.message === 'invalid_or_expired_token') {
        setError('انتهت صلاحية الرابط أو أنه غير صحيح — اطلب رابطًا جديدًا.');
      } else {
        setError('تعذر إعادة تعيين كلمة المرور، حاول مرة أخرى.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-900 px-4" dir="rtl">
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-xl">
        <h1 className="mb-1 text-2xl font-bold text-slate-800">تعيين كلمة مرور جديدة</h1>
        {done ? (
          <>
            <p className="mb-6 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-700">تم تحديث كلمة المرور بنجاح.</p>
            <Link to="/login" className="block w-full rounded-lg bg-emerald-600 py-2.5 text-center font-semibold text-white hover:bg-emerald-700">
              تسجيل الدخول
            </Link>
          </>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-600">كلمة المرور الجديدة</label>
              <input
                type="password"
                required
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
                placeholder="٨ أحرف على الأقل"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-600">تأكيد كلمة المرور</label>
              <input
                type="password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
              />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-lg bg-emerald-600 py-2.5 font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-60"
            >
              {busy ? 'جارِ الحفظ...' : 'حفظ كلمة المرور'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
