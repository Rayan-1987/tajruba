export interface SurveyQuestion {
  id: string;
  code: string;
  text_ar: string;
  text_en: string;
  answer_type: 'likert5' | 'nps' | 'yesno' | 'text' | 'vas';
  depends_on_code: string | null;
}

const LIKERT_LABELS: Record<'ar' | 'en', string[]> = {
  ar: ['غير راضٍ إطلاقًا', 'غير راضٍ', 'محايد', 'راضٍ', 'راضٍ جدًا'],
  en: ['Very dissatisfied', 'Dissatisfied', 'Neutral', 'Satisfied', 'Very satisfied']
};
const YES_NO_LABELS: Record<'ar' | 'en', [string, string]> = { ar: ['نعم', 'لا'], en: ['Yes', 'No'] };

const FOCUS_RING = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600';

export function SurveyQuestionCard({
  question,
  value,
  language = 'ar',
  accentColor,
  onSelect,
  onSelectWithClear
}: {
  question: SurveyQuestion;
  value: number | undefined;
  language?: 'ar' | 'en';
  /** Tenant brand color (RFP UX-05); falls back to the default emerald accent when unset. */
  accentColor?: string;
  onSelect: (value: number) => void;
  onSelectWithClear: (value: number) => void;
}) {
  const [yesLabel, noLabel] = YES_NO_LABELS[language];
  const headingId = `q-${question.id}`;
  const questionText = language === 'en' ? question.text_en : question.text_ar;
  const selectedClass = (selected: boolean) =>
    selected ? (accentColor ? 'text-white' : 'bg-emerald-500 text-white') : 'bg-slate-100 text-slate-600 hover:bg-slate-200';
  const selectedStyle = (selected: boolean) => (selected && accentColor ? { backgroundColor: accentColor } : undefined);
  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm">
      <p id={headingId} className="mb-3 font-medium text-slate-800">
        {questionText}
      </p>
      {question.answer_type === 'yesno' && (
        <div className="flex gap-2" role="radiogroup" aria-labelledby={headingId}>
          <button
            type="button"
            role="radio"
            aria-checked={value === 1}
            onClick={() => onSelect(1)}
            style={selectedStyle(value === 1)}
            className={`flex-1 rounded-xl py-3 text-sm font-semibold transition ${FOCUS_RING} ${selectedClass(value === 1)}`}
          >
            {yesLabel}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={value === 0}
            onClick={() => onSelectWithClear(0)}
            style={selectedStyle(value === 0)}
            className={`flex-1 rounded-xl py-3 text-sm font-semibold transition ${FOCUS_RING} ${selectedClass(value === 0)}`}
          >
            {noLabel}
          </button>
        </div>
      )}
      {question.answer_type === 'likert5' && (
        <div className="flex justify-between gap-1" role="radiogroup" aria-labelledby={headingId}>
          {[1, 2, 3, 4, 5].map((v) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={value === v}
              aria-label={LIKERT_LABELS[language][v - 1]}
              onClick={() => onSelect(v)}
              style={selectedStyle(value === v)}
              className={`flex-1 rounded-xl py-3 text-sm font-semibold transition ${FOCUS_RING} ${selectedClass(value === v)}`}
              title={LIKERT_LABELS[language][v - 1]}
            >
              {v}
            </button>
          ))}
        </div>
      )}
      {question.answer_type === 'nps' && (
        <div className="grid grid-cols-11 gap-1" role="radiogroup" aria-labelledby={headingId}>
          {Array.from({ length: 11 }, (_, i) => i).map((v) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={value === v}
              aria-label={language === 'en' ? `${v} out of 10` : `${v} من 10`}
              onClick={() => onSelect(v)}
              style={selectedStyle(value === v)}
              className={`rounded-lg py-2 text-xs font-semibold transition ${FOCUS_RING} ${selectedClass(value === v)}`}
            >
              {v}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
