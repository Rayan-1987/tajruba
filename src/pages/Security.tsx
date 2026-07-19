import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../AuthContext';

export default function Security() {
  const { user } = useAuth();
  const [enrollment, setEnrollment] = useState<{ secret: string; otpauthUri: string; qrCodeDataUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [disablePassword, setDisablePassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const startEnrollment = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await api.post<{ secret: string; otpauthUri: string; qrCodeDataUrl: string }>('/auth/mfa/enroll', {});
      setEnrollment(res);
    } catch {
      setError('تعذر بدء إعداد المصادقة الثنائية.');
    } finally {
      setBusy(false);
    }
  };

  const confirmEnrollment = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await api.post<{ recoveryCodes: string[] }>('/auth/mfa/verify-enrollment', { code: code.trim() });
      setRecoveryCodes(res.recoveryCodes);
      setEnrollment(null);
      setCode('');
    } catch {
      setError('رمز التحقق غير صحيح، حاولي مرة أخرى.');
    } finally {
      setBusy(false);
    }
  };

  const disableMfa = async () => {
    setError(null);
    setBusy(true);
    try {
      await api.post('/auth/mfa/disable', { password: disablePassword });
      setDisablePassword('');
      setRecoveryCodes(null);
      window.location.reload();
    } catch {
      setError('كلمة المرور غير صحيحة.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-800">الأمان</h2>
        <p className="text-sm text-slate-500">إدارة المصادقة الثنائية (Two-Factor Authentication) لحسابك</p>
      </div>

      <div className="rounded-2xl bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-700">المصادقة الثنائية (TOTP)</h3>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
              user?.mfaEnabled ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'
            }`}
          >
            {user?.mfaEnabled ? 'مفعّلة' : 'غير مفعّلة'}
          </span>
        </div>
        <p className="mb-3 text-xs text-slate-500">
          تضيف طبقة حماية إضافية: بعد إدخال كلمة المرور، سيُطلب رمز من تطبيق مصادقة (مثل Google Authenticator أو Authy).
        </p>

        {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

        {recoveryCodes && (
          <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs">
            <p className="mb-2 font-semibold text-amber-800">
              احفظي رموز الاسترداد التالية في مكان آمن — تُعرض مرة واحدة فقط، وتُستخدم لتسجيل الدخول عند فقدان جهاز المصادقة.
            </p>
            <div className="grid grid-cols-2 gap-1 font-mono text-amber-900">
              {recoveryCodes.map((c) => (
                <span key={c}>{c}</span>
              ))}
            </div>
          </div>
        )}

        {!user?.mfaEnabled && !enrollment && (
          <button
            type="button"
            onClick={startEnrollment}
            disabled={busy}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
          >
            تفعيل المصادقة الثنائية
          </button>
        )}

        {enrollment && (
          <div className="space-y-3">
            <p className="text-xs text-slate-600">امسحي رمز QR التالي باستخدام تطبيق المصادقة، ثم أدخلي الرمز المكوّن من 6 أرقام:</p>
            <img src={enrollment.qrCodeDataUrl} alt="QR code" className="h-40 w-40" />
            <p className="break-all text-[10px] text-slate-400">أو أدخلي المفتاح يدويًا: {enrollment.secret}</p>
            <div className="flex gap-2">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="000000"
                className="w-32 rounded-lg border border-slate-300 px-3 py-2 text-center text-sm"
              />
              <button
                type="button"
                onClick={confirmEnrollment}
                disabled={busy}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
              >
                تأكيد وتفعيل
              </button>
            </div>
          </div>
        )}

        {user?.mfaEnabled && (
          <div className="space-y-2">
            <p className="text-xs text-slate-500">لإيقاف المصادقة الثنائية، أدخلي كلمة المرور الحالية:</p>
            <div className="flex gap-2">
              <input
                type="password"
                value={disablePassword}
                onChange={(e) => setDisablePassword(e.target.value)}
                placeholder="كلمة المرور"
                className="w-48 rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
              <button
                type="button"
                onClick={disableMfa}
                disabled={busy}
                className="rounded-lg border border-red-300 px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-60"
              >
                إيقاف المصادقة الثنائية
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
