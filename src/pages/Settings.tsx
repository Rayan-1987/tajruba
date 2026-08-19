import { useEffect, useState } from 'react';
import { api } from '../api';

interface IntegrationsSettings {
  smsProvider: string;
  smsSenderName: string | null;
  smsApiKeyMasked: string | null;
  defaultLanguage: string;
  hisWebhookEnabled: boolean;
  hisWebhookConfigured: boolean;
  hisWebhookUrl: string;
  hisEpisodesWebhookUrl: string;
}

interface DncEntry {
  id: string;
  reason: string | null;
  created_at: string;
}

interface BackupInfo {
  backups: { fileName: string; sizeBytes: number; createdAt: string }[];
  lastBackupAt: string | null;
  retentionDays: number;
  rpoTargetHours: number;
  rtoTargetHours: number;
}

export default function Settings() {
  const [settings, setSettings] = useState<IntegrationsSettings | null>(null);
  const [smsProvider, setSmsProvider] = useState('console');
  const [smsApiKey, setSmsApiKey] = useState('');
  const [smsSenderName, setSmsSenderName] = useState('');
  const [defaultLanguage, setDefaultLanguage] = useState('ar');
  const [testPhone, setTestPhone] = useState('');
  const [testResult, setTestResult] = useState<string | null>(null);
  const [saveResult, setSaveResult] = useState<string | null>(null);
  const [newWebhookKey, setNewWebhookKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [dncEntries, setDncEntries] = useState<DncEntry[]>([]);
  const [cooldownDays, setCooldownDays] = useState(90);
  const [dncPhone, setDncPhone] = useState('');
  const [dncReason, setDncReason] = useState('');

  const load = () => {
    api.get<IntegrationsSettings>('/settings/integrations').then((res) => {
      setSettings(res);
      setSmsProvider(res.smsProvider);
      setSmsSenderName(res.smsSenderName ?? '');
      setDefaultLanguage(res.defaultLanguage);
    });
  };
  useEffect(load, []);

  const loadDnc = () => {
    api.get<{ entries: DncEntry[]; cooldownDays: number }>('/settings/do-not-contact').then((res) => {
      setDncEntries(res.entries);
      setCooldownDays(res.cooldownDays);
    });
  };
  useEffect(loadDnc, []);

  const [backupInfo, setBackupInfo] = useState<BackupInfo | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const loadBackups = () => {
    api.get<BackupInfo>('/settings/backups').then(setBackupInfo);
  };
  useEffect(loadBackups, []);

  const runBackupNow = async () => {
    setBackupBusy(true);
    try {
      await api.post('/settings/backups/run');
      loadBackups();
    } finally {
      setBackupBusy(false);
    }
  };

  const addDncEntry = async () => {
    if (!dncPhone) return;
    await api.post('/settings/do-not-contact', { phone: dncPhone, reason: dncReason || undefined });
    setDncPhone('');
    setDncReason('');
    loadDnc();
  };

  const removeDncEntry = async (id: string) => {
    await api.delete(`/settings/do-not-contact/${id}`);
    loadDnc();
  };

  const save = async () => {
    setBusy(true);
    setSaveResult(null);
    try {
      await api.patch('/settings/integrations', {
        smsProvider,
        smsApiKey: smsApiKey || undefined,
        smsSenderName,
        defaultLanguage
      });
      setSmsApiKey('');
      setSaveResult('تم الحفظ بنجاح.');
      load();
    } catch {
      setSaveResult('تعذر الحفظ، حاول مرة أخرى.');
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    if (!testPhone) return;
    setTestResult('جارِ الإرسال...');
    try {
      const res = await api.post<{ ok: boolean; provider: string; error?: string }>('/settings/integrations/test-sms', {
        phone: testPhone
      });
      setTestResult(res.ok ? `تم الإرسال بنجاح عبر ${res.provider}.` : `فشل الإرسال: ${res.error ?? 'خطأ غير معروف'}`);
    } catch {
      setTestResult('تعذر إرسال الرسالة التجريبية.');
    }
  };

  const regenerateWebhookKey = async () => {
    if (!confirm('توليد مفتاح جديد سيُبطل أي مفتاح سابق مستخدم من نظام المستشفى. متابعة؟')) return;
    const res = await api.post<{ key: string }>('/settings/integrations/webhook-key/regenerate');
    setNewWebhookKey(res.key);
    load();
  };

  if (!settings) return null;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-800">الإعدادات — الربط والتكامل</h2>
        <p className="text-sm text-slate-500">إعدادات هذا المستشفى فقط — لا تؤثر على أي مستشفى آخر على المنصة</p>
      </div>

      <div className="rounded-2xl bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-sm font-semibold text-slate-700">مزوّد الرسائل (SMS / WhatsApp)</h3>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">المزوّد</label>
            <select value={smsProvider} onChange={(e) => setSmsProvider(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
              <option value="console">بدون إرسال فعلي (وضع تجريبي — تسجيل فقط)</option>
              <option value="unifonic">Unifonic</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">اللغة الافتراضية للرسائل</label>
            <select value={defaultLanguage} onChange={(e) => setDefaultLanguage(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
              <option value="ar">العربية</option>
              <option value="en">English</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">اسم المرسل (Sender Name)</label>
            <input
              value={smsSenderName}
              onChange={(e) => setSmsSenderName(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              placeholder="Tajruba"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">
              مفتاح API {settings.smsApiKeyMasked && <span className="text-slate-400">(الحالي: {settings.smsApiKeyMasked})</span>}
            </label>
            <input
              type="password"
              value={smsApiKey}
              onChange={(e) => setSmsApiKey(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              placeholder="اترك فارغًا إذا لا تريد تغييره"
            />
          </div>
        </div>
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="mt-3 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
        >
          حفظ الإعدادات
        </button>
        {saveResult && <p className="mt-2 text-sm text-slate-600">{saveResult}</p>}

        <div className="mt-4 border-t border-slate-100 pt-4">
          <p className="mb-2 text-xs font-medium text-slate-500">إرسال رسالة تجريبية للتأكد من صحة الإعدادات</p>
          <div className="flex gap-2">
            <input
              value={testPhone}
              onChange={(e) => setTestPhone(e.target.value)}
              className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
              placeholder="رقم جوال للاختبار"
            />
            <button type="button" onClick={sendTest} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
              إرسال تجريبي
            </button>
          </div>
          {testResult && <p className="mt-2 text-sm text-slate-600">{testResult}</p>}
        </div>
      </div>

      <div className="rounded-2xl bg-white p-4 shadow-sm">
        <h3 className="mb-1 text-sm font-semibold text-slate-700">الربط مع نظام المستشفى (HIS/EMR)</h3>
        <p className="mb-3 text-xs text-slate-500">
          أعط فريق تقنية المعلومات في المستشفى المفتاح أدناه ليتمكنوا من ربط نظامهم بمنصة تجربة — نفس المفتاح يُستخدم
          لإرسال دعوات الاستبيانات تلقائيًا عند خروج كل مريض، ولبدء حلقات متابعة PROMs تلقائيًا (مثل برنامج استبدال
          مفصل الركبة) دون الحاجة لتسجيل دخول بشري.
        </p>
        <div className="mb-3 rounded-lg bg-slate-50 p-3 text-xs">
          <p className="mb-1 font-semibold text-slate-600">١. دعوات الاستبيانات (POST):</p>
          <code className="break-all text-slate-700">{settings.hisWebhookUrl}</code>
          <p className="mb-1 mt-2 font-semibold text-slate-600">نص الطلب (Body، JSON):</p>
          <code className="text-slate-700">{'{ "templateId": "...", "departmentId": "...", "rows": [{ "phone": "05xxxxxxxx" }] }'}</code>
          <p className="mb-1 mt-3 font-semibold text-slate-600">٢. بدء حلقة متابعة PROMs (POST):</p>
          <code className="break-all text-slate-700">{settings.hisEpisodesWebhookUrl}</code>
          <p className="mb-1 mt-2 font-semibold text-slate-600">نص الطلب (Body، JSON):</p>
          <code className="text-slate-700">
            {
              '{ "pathwayId": "...", "departmentId": "...", "patientRef": "MRN123", "contactPhone": "05xxxxxxxx", "consent": true, "startDate": "2026-01-01" }'
            }
          </code>
          <p className="mb-2 text-[11px] text-amber-700">
            ملاحظة: عند إرفاق contactPhone يجب إرسال "consent": true لتأكيد موافقة المريض على المتابعة الطولية، وإلا يُرفض الطلب.
          </p>
          <p className="mb-1 mt-3 font-semibold text-slate-600">الترويسة المطلوبة لكلا الرابطين (Header):</p>
          <code className="text-slate-700">X-Api-Key: &lt;المفتاح&gt;</code>
        </div>
        <p className="mb-2 text-xs text-slate-500">
          الحالة: {settings.hisWebhookConfigured ? (settings.hisWebhookEnabled ? '✅ مفعّل' : '⏸️ موقوف') : 'لم يتم توليد مفتاح بعد'}
        </p>
        <button
          type="button"
          onClick={regenerateWebhookKey}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
        >
          {settings.hisWebhookConfigured ? 'توليد مفتاح جديد (يُبطل القديم)' : 'توليد مفتاح'}
        </button>
        {newWebhookKey && (
          <div className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
            <p className="mb-1 font-semibold">انسخ هذا المفتاح الآن — لن يظهر مرة أخرى:</p>
            <code className="break-all">{newWebhookKey}</code>
          </div>
        )}
      </div>

      <div className="rounded-2xl bg-white p-4 shadow-sm">
        <h3 className="mb-1 text-sm font-semibold text-slate-700">قائمة عدم التواصل (Do Not Contact)</h3>
        <p className="mb-3 text-xs text-slate-500">
          أي رقم في هذه القائمة لن يتم دعوته لأي استبيان مطلقًا. كما لا تتم دعوة نفس الرقم مرتين خلال {cooldownDays} يومًا
          تلقائيًا لتفادي إرهاق المريض بالاستبيانات المتكررة.
        </p>
        <div className="mb-3 flex flex-wrap gap-2">
          <input
            value={dncPhone}
            onChange={(e) => setDncPhone(e.target.value)}
            className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
            placeholder="رقم الجوال"
          />
          <input
            value={dncReason}
            onChange={(e) => setDncReason(e.target.value)}
            className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
            placeholder="السبب (اختياري)"
          />
          <button
            type="button"
            onClick={addDncEntry}
            className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-900"
          >
            إضافة
          </button>
        </div>
        {dncEntries.length === 0 ? (
          <p className="text-xs text-slate-400">لا توجد أرقام في القائمة حاليًا.</p>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {dncEntries.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between py-2">
                <span className="text-slate-600">{entry.reason || 'بدون سبب مذكور'}</span>
                <button type="button" onClick={() => removeDncEntry(entry.id)} className="text-xs font-semibold text-red-600 hover:underline">
                  إزالة
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-2xl bg-white p-4 shadow-sm">
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-700">النسخ الاحتياطي</h3>
          <button
            type="button"
            disabled={backupBusy}
            onClick={runBackupNow}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {backupBusy ? 'جارِ التنفيذ...' : 'تنفيذ نسخة احتياطية الآن'}
          </button>
        </div>
        {backupInfo && (
          <>
            <p className="mb-3 text-xs text-slate-500">
              نسخة احتياطية تلقائية يوميًا · هدف نقطة الاسترجاع (RPO) {backupInfo.rpoTargetHours} ساعات · هدف زمن الاسترجاع (RTO)
              {' '}
              {backupInfo.rtoTargetHours} ساعات · الاحتفاظ {backupInfo.retentionDays} يومًا
            </p>
            <p className="mb-3 text-xs text-slate-600">
              آخر نسخة: {backupInfo.lastBackupAt ? new Date(backupInfo.lastBackupAt).toLocaleString('ar-SA') : 'لا توجد نسخ بعد'}
            </p>
            {backupInfo.backups.length > 0 && (
              <ul className="divide-y divide-slate-100 text-xs">
                {backupInfo.backups.slice(0, 10).map((b) => (
                  <li key={b.fileName} className="flex items-center justify-between py-1.5">
                    <span className="text-slate-600">{new Date(b.createdAt).toLocaleString('ar-SA')}</span>
                    <span className="text-slate-400">{(b.sizeBytes / 1024 / 1024).toFixed(2)} MB</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}
