import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Xarajatga ta'sir qiladigan sozlamalar.
 *
 * Railway xotira x vaqt uchun pul oladi va bot 24/7 turadi. Long polling
 * Telegramga doimiy ochiq ulanish ushlab, 50 ta parallel ishlovchi bilan
 * jarayonni hech qachon bo'sh qoldirmaydi; daqiqalik fon tiklari esa har
 * safar bazaga so'rov yuboradi. Ikkalasi ham bu bot uchun keraksiz.
 *
 * Bu testlar bazani talab qilmaydi — shuning uchun MongoDB bo'lmasa ham
 * ishlaydi va sozlama tasodifan orqaga qaytib ketsa darrov aytadi.
 */

const root = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

describe('xarajat sozlamalari', () => {
  it('public URL bor bo‘lsa webhook tanlanadi, polling emas', () => {
    const env = read('src/config/env.ts');
    expect(env).toContain("default('auto')");

    const index = read('src/index.ts');
    expect(index).toContain("env.BOT_MODE !== 'polling' && Boolean(env.publicUrl)");
  });

  it('BOT_MODE=polling bilan eski xulqni qaytarib olish mumkin', () => {
    const env = read('src/config/env.ts');
    expect(env).toContain("z.enum(['polling', 'webhook', 'auto'])");
  });

  it('public URL yo‘q bo‘lsa polling‘ga tushadi', () => {
    // Shart: BOT_MODE != polling VA publicUrl bor. URL bo'lmasa ikkinchi
    // shart yiqiladi va bot pollingda ishlaydi — lokalda aynan shunday kerak.
    const index = read('src/index.ts');
    const cond = /const useWebhook = (.+);/.exec(index)?.[1] ?? '';
    expect(cond).toContain('Boolean(env.publicUrl)');
  });

  it('fon tiklari daqiqalik emas', () => {
    const index = read('src/index.ts');
    // Eslatmalar ~1 soat va ~20 soatda ketadi — daqiqalik tekshiruv ortiqcha
    expect(index).toContain('const TICK = 5 * MINUTE');

    const ticks = [...index.matchAll(/setInterval\([\s\S]*?,\s*([^)]+)\)[,;]/g)].map((m) => m[1].trim());
    expect(ticks.length).toBeGreaterThan(0);
    for (const t of ticks) {
      expect(t, `tik juda tez: ${t}`).not.toBe('MINUTE');
      expect(t, `tik juda tez: ${t}`).not.toBe('2 * MINUTE');
    }
  });

  it('bitta replika yetadi', () => {
    const railway = JSON.parse(read('railway.json'));
    expect(railway.deploy.numReplicas).toBe(1);
  });

  it('runtime obrazida dev paketlar yo‘q', () => {
    // npm prune --omit=dev bo'lmasa obraz kattalashadi va build sekinlashadi
    expect(read('Dockerfile')).toContain('npm prune --omit=dev');
  });
});
