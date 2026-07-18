export interface SurveyQuestion {
  id: string;
  code: string;
  text_ar: string;
  text_en: string;
  answer_type: 'likert5' | 'nps' | 'yesno' | 'text' | 'vas';
  depends_on_code: string | null;
}

const LIKERT_LABELS = ['غير راضٍ إطلاقًا', 'غير راضٍ', 'محايد', 'راضٍ', 'راضٍ جدًا'];

export function SurveyQuestionCard({
  question,
  value,
  onSelect,
  onSelectWithClear
}: {
  question: SurveyQuestion;
  value: number | undefined;
  onSelect: (value: number) => void;
  onSelectWithClear: (value: number) => void;
}) {
  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm">
      <p className="mb-3 font-medium text-slate-800">{question.text_ar}</p>
      {question.answer_type === 'yesno' && (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onSelect(1)}
            className={`flex-1 rounded-xl py-3 text-sm font-semibold transition ${
              value === 1 ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            نعم
          </button>
          <button
            type="button"
            onClick={() => onSelectWithClear(0)}
            className={`flex-1 rounded-xl py-3 text-sm font-semibold transition ${
              value === 0 ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            لا
          </button>
        </div>
      )}
      {question.answer_type === 'likert5' && (
        <div className="flex justify-between gap-1">
          {[1, 2, 3, 4, 5].map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => onSelect(v)}
              className={`flex-1 rounded-xl py-3 text-sm font-semibold transition ${
                value === v ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
              title={LIKERT_LABELS[v - 1]}
            >
              {v}
            </button>
          ))}
        </div>
      )}
      {question.answer_type === 'nps' && (
        <div className="grid grid-cols-11 gap-1">
          {Array.from({ length: 11 }, (_, i) => i).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => onSelect(v)}
              className={`rounded-lg py-2 text-xs font-semibold transition ${
                value === v ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {v}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
