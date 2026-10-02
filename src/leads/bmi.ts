/** TMI (BMI) = weight(kg) / height(m)^2, rounded to one decimal. Calculated by the backend, never the LLM. */
export function calcBmi(weightKg?: number | null, heightCm?: number | null): number | undefined {
  if (!weightKg || !heightCm) return undefined;
  const m = heightCm / 100;
  if (m <= 0) return undefined;
  return Math.round((weightKg / (m * m)) * 10) / 10;
}

export type BmiBand = 'high' | 'low' | 'mid';

export function bmiBand(bmi: number | undefined, high = 25, low = 21): BmiBand {
  if (bmi === undefined) return 'mid';
  if (bmi >= high) return 'high';
  if (bmi < low) return 'low';
  return 'mid';
}
