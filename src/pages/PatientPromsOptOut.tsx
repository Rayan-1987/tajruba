import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';

export default function PatientPromsOptOut() {
  const { token = '' } = useParams();
  const [status, setStatus] = useState<'pending' | 'done' | 'error'>('pending');

  useEffect(() => {
    api
      .post(`/public/proms/${token}/opt-out`, {})
      .then(() => setStatus('done'))
      .catch(() => setStatus('error'));
  }, [token]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-6" dir="rtl">
      <div className="max-w-sm rounded-2xl bg-white p-8 text-center shadow-sm">
        {status === 'pending' && <p className="text-slate-500">جارِ إيقاف الرسائل...</p>}
        {status === 'done' && (
          <>
            <div className="mb-3 text-4xl">✓</div>
            <h1 className="mb-2 text-xl font-bold text-slate-800">تم إيقاف الرسائل</h1>
            <p className="text-slate-600">لن تصلك رسائل متابعة أخرى لهذا البرنامج. رعايتك الطبية لن تتأثر بذلك.</p>
          </>
        )}
        {status === 'error' && <p className="text-slate-700">تعذر إتمام الطلب، الرجاء التواصل مع المستشفى مباشرة.</p>}
      </div>
    </div>
  );
}
