import type { LeadAnswers, QuestionStep } from '../types/domain';
import type { Lang } from '../utils/text';
import type { SettingsService } from '../services/settings';
import { bmiBand } from './bmi';

const has = (v: unknown) => v !== undefined && v !== null && String(v).trim() !== '';

/** Which answer fields close each question. */
export const STEP_FIELDS: Record<Exclude<QuestionStep, 6>, (keyof LeadAnswers)[]> = {
  1: ['height', 'weight', 'age', 'trainingExperience'],
  2: ['goal'],
  3: ['trainingDays', 'trainingLocation'],
  4: ['previousAttempts'],
  5: ['healthProblems'],
};

export function missingFields(answers: LeadAnswers, step: Exclude<QuestionStep, 6>): (keyof LeadAnswers)[] {
  return STEP_FIELDS[step].filter((f) => !has(answers[f]));
}

/** First question that still has a missing field; 6 when the questionnaire is complete. */
export function nextStep(answers: LeadAnswers, skipped: number[] = []): QuestionStep {
  for (const step of [1, 2, 3, 4, 5] as const) {
    if (skipped.includes(step)) continue;
    if (missingFields(answers, step).length > 0) return step;
  }
  return 6;
}

export async function questionText(
  step: QuestionStep,
  lang: Lang,
  bmi: number | undefined,
  settings: SettingsService,
): Promise<string> {
  switch (step) {
    case 1:
      return settings.text('first_message', lang);
    case 2: {
      const band = bmiBand(bmi, await settings.num('bmi_high'), await settings.num('bmi_low'));
      return settings.text(`q2_${band}`, lang);
    }
    case 3:
      return settings.text('q3', lang);
    case 4:
      return settings.text('q4', lang);
    case 5:
      return settings.text('q5', lang);
    default:
      return settings.text('ready_message', lang);
  }
}

/** Short hint for the LLM about what exactly is missing inside the current step. */
export function missingHint(answers: LeadAnswers, step: QuestionStep): string {
  if (step === 6) return '';
  const names: Record<string, string> = {
    height: "bo'y",
    weight: 'vazn',
    age: 'yosh',
    trainingExperience: 'trenirovka tajribasi',
    goal: 'maqsad',
    trainingDays: 'haftasiga necha kun',
    trainingLocation: 'zal yoki uy',
    previousAttempts: 'oldingi urinish va nima xalaqit bergan',
    healthProblems: "sog'liq muammolari",
  };
  return missingFields(answers, step).map((f) => names[f] ?? f).join(', ');
}
