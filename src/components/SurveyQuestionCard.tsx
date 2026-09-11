export type DependsOnOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte';

export interface SurveyQuestion {
  id: string;
  code: string;
  text_ar: string;
  text_en: string;
  answer_type: 'likert5' | 'nps' | 'yesno' | 'freq4' | 'text' | 'vas';
  depends_on_code: string | null;
  depends_on_operator?: DependsOnOperator | null;
  depends_on_value?: number | null;
}

/**
 * Evaluates a branching gate: whether a question depending on `gateValue` should be visible.
 * Defaults to the original yes/no-gate behavior (equals 1) when operator/threshold are unset,
 * so existing Lab/Radiology/Pharmacy ancillary gates keep working unchanged.
 */
export function evaluateGate(gateValue: number | undefined, operator: DependsOnOperator | null | undefined, threshold: number | null | undefined): boolean {
  if (gateValue === undefined) return false;
  const t = threshold ?? 1;
  switch (operator ?? 'eq') {
    case 'neq':
      return gateValue !== t;
    case 'gt':
      return gateValue > t;
    case 'gte':
      return gateValue >= t;
    case 'lt':
      return gateValue < t;
    case 'lte':
      return gateValue <= t;
    case 'eq':
    default:
      return gateValue === t;
  }
}

const LIKERT_LABELS: Record<'ar' | 'en', string[]> = {
  ar: ['غير راضٍ إطلاقًا', 'غير راضٍ', 'محايد', 'راضٍ', 'راضٍ جدًا'],
  en: ['Very dissatisfied', 'Dissatisfied', 'Neutral', 'Satisfied', 'Very satisfied']
};
const YES_NO_LABELS: Record<'ar' | 'en', [string, string]> = { ar: ['نعم', 'لا'], en: ['Yes', 'No'] };

// Standard CAHPS 4-point frequency scale (used across real-world patient-experience surveys for
// process items — "did staff explain X", "were you kept informed" — rather than a satisfaction
// scale). Stored on values 1/2/4/5 (3 intentionally skipped) so "Always" lands on 5 and keeps
// working unchanged with the existing topBoxPercent(>= 5)/mean scoring built for the 1-5 scale.
export const FREQ4_LABELS: Record<'ar' | 'en', string[]> = {
  ar: ['أبدًا', 'أحيانًا', 'غالبًا', 'دائمًا'],
  en: ['Never', 'Sometimes', 'Usually', 'Always']
};
export const FREQ4_VALUES = [1, 2, 4, 5] as const;

const NPS_ENDPOINT_LABELS: Record<'ar' | 'en', [string, string]> = {
  ar: ['غير محتمل إطلاقًا', 'محتمل جدًا'],
  en: ['Not at all likely', 'Extremely likely']
};

const FOCUS_RING = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600';

/** A full-width, clearly-labeled option row — the shared answering interaction for every
 * scale-type question (yes/no, 1-5 satisfaction, 4-point frequency), so patients learn one tap
 * pattern for the whole survey instead of a different tiny-button layout per question type. */
function OptionRow({
  label,
  chip,
  selected,
  accentColor,
  onClick
}: {
  label: string;
  chip?: string;
  selected: boolean;
  accentColor?: string;
  onClick: () => void;
}) {
  const selectedStyle = selected && accentColor ? { backgroundColor: accentColor, borderColor: accentColor } : undefined;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      style={selectedStyle}
      className={`flex w-full items-center gap-3 rounded-xl border-2 px-4 py-3.5 text-start text-sm font-semibold transition ${FOCUS_RING} ${
        selected
          ? accentColor
            ? 'text-white'
            : 'border-emerald-500 bg-emerald-500 text-white'
          : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300 hover:bg-slate-100'
      }`}
    >
      {chip && (
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
            selected ? 'bg-white/25 text-white' : 'bg-white text-slate-500'
          }`}
        >
          {chip}
        </span>
      )}
      <span>{label}</span>
    </button>
  );
}

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
  const [npsLowLabel, npsHighLabel] = NPS_ENDPOINT_LABELS[language];
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
        <div className="flex flex-col gap-2" role="radiogroup" aria-labelledby={headingId}>
          <OptionRow label={yesLabel} selected={value === 1} accentColor={accentColor} onClick={() => onSelect(1)} />
          <OptionRow label={noLabel} selected={value === 0} accentColor={accentColor} onClick={() => onSelectWithClear(0)} />
        </div>
      )}
      {question.answer_type === 'likert5' && (
        <div className="flex flex-col gap-2" role="radiogroup" aria-labelledby={headingId}>
          {[1, 2, 3, 4, 5].map((v) => (
            <OptionRow
              key={v}
              label={LIKERT_LABELS[language][v - 1]}
              chip={String(v)}
              selected={value === v}
              accentColor={accentColor}
              onClick={() => onSelect(v)}
            />
          ))}
        </div>
      )}
      {question.answer_type === 'freq4' && (
        <div className="flex flex-col gap-2" role="radiogroup" aria-labelledby={headingId}>
          {FREQ4_VALUES.map((v, i) => (
            <OptionRow
              key={v}
              label={FREQ4_LABELS[language][i]}
              selected={value === v}
              accentColor={accentColor}
              onClick={() => onSelect(v)}
            />
          ))}
        </div>
      )}
      {question.answer_type === 'nps' && (
        <div role="radiogroup" aria-labelledby={headingId}>
          <div className="grid grid-cols-11 gap-1">
            {Array.from({ length: 11 }, (_, i) => i).map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={value === v}
                aria-label={language === 'en' ? `${v} out of 10` : `${v} من 10`}
                onClick={() => onSelect(v)}
                style={selectedStyle(value === v)}
                className={`rounded-lg py-2.5 text-xs font-semibold transition ${FOCUS_RING} ${selectedClass(value === v)}`}
              >
                {v}
              </button>
            ))}
          </div>
          <div className="mt-1.5 flex justify-between text-[11px] text-slate-400">
            <span>{npsLowLabel}</span>
            <span>{npsHighLabel}</span>
          </div>
        </div>
      )}
    </div>
  );
}
