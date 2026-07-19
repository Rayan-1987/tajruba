import { Link } from 'react-router-dom';

export default function DataProcessingAgreement() {
  return (
    <div dir="rtl" className="mx-auto max-w-3xl bg-white px-6 py-10 text-slate-700">
      <div className="mb-6 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800">
        <p className="font-semibold">تنبيه: هذه مسودة نموذجية (Template) وليست وثيقة قانونية نافذة.</p>
        <p className="mt-1">
          يجب مراجعتها من قِبل مستشار قانوني مختص بنظام حماية البيانات الشخصية السعودي (PDPL) ولوائحه التنفيذية قبل توقيعها
          مع أي عميل، وتحديثها لتعكس الترتيبات الفعلية لاستضافة البيانات والجهات الفرعية المُعالِجة (Sub-processors) المستخدمة
          فعليًا.
        </p>
      </div>

      <h1 className="mb-2 text-2xl font-bold text-slate-800">اتفاقية معالجة البيانات</h1>
      <p className="mb-6 text-sm text-slate-400">Data Processing Agreement (DPA)</p>

      <div className="space-y-5 text-sm leading-relaxed">
        <section>
          <h2 className="mb-1 font-semibold text-slate-800">1. الأدوار</h2>
          <p>
            العميل (المنشأة الصحية) هو المتحكم بالبيانات (Data Controller). تجربة (Tajruba) هي معالج البيانات (Data
            Processor)، وتقتصر معالجتها للبيانات الشخصية على ما يلزم لتقديم الخدمة المتفق عليها.
          </p>
        </section>
        <section>
          <h2 className="mb-1 font-semibold text-slate-800">2. أنواع البيانات المعالجة</h2>
          <p>
            أرقام جوال المرضى (مُجزّأة/مشفّرة بحسب الغرض)، إجابات الاستبيانات، التعليقات النصية (بعد إخفاء المعرّفات الشخصية
            تلقائيًا حيثما أمكن)، وبيانات تعريف محدودة لأغراض المتابعة العلاجية طويلة الأمد (PROMs) عند موافقة المريض الصريحة.
          </p>
        </section>
        <section>
          <h2 className="mb-1 font-semibold text-slate-800">3. أساس المعالجة والموافقة</h2>
          <p>
            تعتمد المنصة على آليات موافقة صريحة عند جمع بيانات تواصل قابلة لإعادة الاستخدام (مثل حلقات المتابعة العلاجية)، مع
            إتاحة خيار الانسحاب (Opt-out) في كل رسالة متابعة.
          </p>
        </section>
        <section>
          <h2 className="mb-1 font-semibold text-slate-800">4. الأمان التقني</h2>
          <p>
            تشفير كلمات المرور (scrypt)، تشفير الحقول الحساسة القابلة للعكس عند التخزين (AES-256-GCM)، تجزئة غير قابلة للعكس
            لأرقام هواتف الاستبيانات المجهولة، عزل بيانات كل منشأة (Multi-tenancy)، وصلاحيات وصول قائمة على الأدوار (RBAC).
          </p>
        </section>
        <section>
          <h2 className="mb-1 font-semibold text-slate-800">5. مكان تخزين البيانات</h2>
          <p>
            [يُحدَّد وفق البنية التحتية الفعلية عند النشر] — يوصى بالاستضافة داخل المملكة العربية السعودية امتثالًا لمتطلبات
            محلية البيانات (Data Residency) الخاصة بالقطاع الصحي، ما لم يُتفق على خلاف ذلك.
          </p>
        </section>
        <section>
          <h2 className="mb-1 font-semibold text-slate-800">6. الاحتفاظ بالبيانات وحذفها</h2>
          <p>يُحدَّد جدول الاحتفاظ بالبيانات وإجراءات الحذف عند انتهاء العقد ضمن الملحق الفني المرفق مع كل عميل.</p>
        </section>
        <section>
          <h2 className="mb-1 font-semibold text-slate-800">7. الإبلاغ عن الاختراقات</h2>
          <p>
            تلتزم تجربة بإبلاغ العميل دون تأخير لا مبرر له عند وقوع أي حادثة أمنية تمس بيانات شخصية يعالجها نيابةً عنه، وفق
            المهل الزمنية التي تفرضها الجهة التنظيمية المختصة.
          </p>
        </section>
        <section>
          <h2 className="mb-1 font-semibold text-slate-800">8. الجهات الفرعية المُعالِجة</h2>
          <p>
            [تُدرَج هنا قائمة أي مزوّدين خارجيين فعليين يُستخدَمون لاحقًا، مثل مزوّد الرسائل النصية أو البريد الإلكتروني، بعد
            التعاقد الفعلي معهم].
          </p>
        </section>
      </div>

      <p className="mt-8 text-sm">
        راجع أيضًا{' '}
        <Link to="/terms" className="font-semibold text-emerald-600 hover:underline">
          شروط الاستخدام
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
