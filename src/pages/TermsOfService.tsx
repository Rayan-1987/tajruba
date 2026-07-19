import { Link } from 'react-router-dom';

export default function TermsOfService() {
  return (
    <div dir="rtl" className="mx-auto max-w-3xl bg-white px-6 py-10 text-slate-700">
      <div className="mb-6 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800">
        <p className="font-semibold">تنبيه: هذه مسودة نموذجية (Template) وليست وثيقة قانونية نافذة.</p>
        <p className="mt-1">
          يجب مراجعتها من قِبل مستشار قانوني مختص قبل استخدامها فعليًا مع أي عميل، للتأكد من توافقها مع الأنظمة السعودية ذات
          الصلة (نظام حماية البيانات الشخصية، أنظمة الرعاية الصحية، إلخ) ومع نموذج التعاقد الفعلي لكل مستشفى.
        </p>
      </div>

      <h1 className="mb-2 text-2xl font-bold text-slate-800">شروط الاستخدام</h1>
      <p className="mb-6 text-sm text-slate-400">منصة تجربة (Tajruba) — Terms of Service</p>

      <div className="space-y-5 text-sm leading-relaxed">
        <section>
          <h2 className="mb-1 font-semibold text-slate-800">1. نطاق الخدمة</h2>
          <p>
            تُقدّم منصة تجربة أدوات لقياس تجربة المريض (PREMs)، والنتائج الصحية المُبلَّغ عنها من المريض (PROMs)، وتحليل
            التعليقات، وإدارة حالات استعادة الخدمة، لمنشآت الرعاية الصحية المشتركة ("المنشأة" أو "العميل").
          </p>
        </section>
        <section>
          <h2 className="mb-1 font-semibold text-slate-800">2. الحساب والاستخدام المصرّح به</h2>
          <p>
            يلتزم العميل بإدارة حسابات مستخدميه، وضمان استخدام المنصة فقط من قِبل موظفين مخوّلين، والامتثال لأي متطلبات
            ترخيص إضافية لاستخدام أدوات قياس مرخّصة (مثل بعض مقاييس PROMs المحمية بحقوق ملكية).
          </p>
        </section>
        <section>
          <h2 className="mb-1 font-semibold text-slate-800">3. ملكية البيانات</h2>
          <p>
            تبقى بيانات المرضى والاستبيانات التي يُنشئها العميل مملوكة للعميل. تُعامل تجربة كمعالج بيانات (Data Processor) نيابة
            عن العميل بصفته المتحكم بالبيانات (Data Controller)، وفق ما هو مفصّل في اتفاقية معالجة البيانات المرفقة.
          </p>
        </section>
        <section>
          <h2 className="mb-1 font-semibold text-slate-800">4. التوفر والصيانة</h2>
          <p>
            تسعى تجربة لتوفير مستوى خدمة معقول، دون التزام بنسبة توفر (SLA) محددة إلا إذا نُصّ عليها صراحة في عقد منفصل مع
            العميل.
          </p>
        </section>
        <section>
          <h2 className="mb-1 font-semibold text-slate-800">5. حدود المسؤولية</h2>
          <p>
            لا تتحمل تجربة مسؤولية القرارات الإكلينيكية المتخذة بناءً على بيانات المنصة. المنصة أداة لقياس التجربة وليست بديلاً
            عن السجلات الطبية الرسمية أو الأنظمة الإكلينيكية المعتمدة.
          </p>
        </section>
        <section>
          <h2 className="mb-1 font-semibold text-slate-800">6. الإنهاء</h2>
          <p>يحق لأي طرف إنهاء الاشتراك وفق الشروط المتفق عليها في العقد التجاري المنفصل، مع تصدير بيانات العميل قبل الإنهاء.</p>
        </section>
        <section>
          <h2 className="mb-1 font-semibold text-slate-800">7. القانون الحاكم</h2>
          <p>تخضع هذه الشروط لأنظمة المملكة العربية السعودية.</p>
        </section>
      </div>

      <p className="mt-8 text-sm">
        راجع أيضًا{' '}
        <Link to="/data-processing-agreement" className="font-semibold text-emerald-600 hover:underline">
          اتفاقية معالجة البيانات
        </Link>
        .
      </p>
      <p className="mt-4">
        <Link to="/login" className="text-xs text-slate-400 hover:underline">
          العودة لتسجيل الدخول
        </Link>
      </p>
    </div>
  );
}
