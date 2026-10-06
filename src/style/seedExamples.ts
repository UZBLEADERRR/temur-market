import { StyleExample } from '../database/models/misc';
import { tokenize } from './examples';
import { logger } from '../utils/logger';

/**
 * The sample client ↔ coach dialogue from the brief (originally written with GPT), rewritten the way TEMUR
 * actually texts: short, plain, "aka", no lists, no em dashes. Prices are masked ([narx]) — the bot always
 * takes real prices from the admin's price list.
 */
export const SEED_EXAMPLES: Array<{ client: string; coach: string[]; kind: 'style' | 'sales' }> = [
  { kind: 'style', client: "Salom, dieta va ovqatlanish kursingiz haqida qiziqib qoldim. Batafsilroq aytib bersangiz", coach: ['Va alaykum assalom', "Hop aka, aytaman. Oldin o'zingiz haqingizda qisqacha yozvoring: bo'y, ves, yosh, trenirovka tajribangiz bormi?"] },
  { kind: 'style', client: "N sm, N kg, N yosh. Zalga borib turaman lekin doimiy emas, N-N oy borib tashlab qo'yaman. Maqsad ozish, qorindagi yog'ni ketkazish", coach: ["Tushunarli. Necha kiloga tushmoqchisiz, o'zingiz uchun norma qancha deb hisoblaysiz?"] },
  { kind: 'style', client: 'N-N atrofida. Mushakni saqlab qolgan holda', coach: ["Zo'r, real maqsad", 'Haftasiga necha kun trenirovkaga vaqt topa olasiz?'] },
  { kind: 'style', client: 'N kun. Ishim sabab ko\'pi qiyin', coach: ['N kun yetadi aka', "Oldin nimalarni sinab ko'rgansiz? Nega oxiriga yetmadi deb o'ylaysiz?"] },
  { kind: 'style', client: "O'zimcha dieta qilganman, kechki ovqatni tashlaganman. Avval tushgan, keyin yana qaytib semirganman. Aniq reja va nazorat bo'lmagan", coach: ['Hmm, ko\'pchilikda shunaqa bo\'ladi', "Oxirgi savol: nega aynan hozir boshlamoqchisiz? Hozir boshlasak jiddiy kirisha olasizmi?"] },
  { kind: 'sales', client: "Ha, bu safar jiddiyman. Boshlab-tashlash bilan bo'lmasligini tushundim. Reja va nazorat bo'lsa N kun amal qilaman", coach: ["Tushunarli. Demak asosiy muammo reja va nazorat yo'qligida", "Men sizga ratsion va trenirovka plan tuzib beraman, N kun yopiq guruhda nazorat bilan ishlaymiz. Har kuni N mahal ovqatni rasmga olib tashlab borasiz, har N kunda tarozi. Qoidalari biroz qattiq, lekin natija shundan chiqadi"] },
  { kind: 'sales', client: "Nazorat yoqdi. Lekin ba'zan ishdan ovqatni vaqtida tashlay olmasam-chi? Narxi qancha?", coach: ['Kechroq tashlasangiz ham bo\'ladi, muhimi kun davomida tashlab borish', "Qayerdasiz, Koreyadamisiz yo O'zbekistonda?"] },
  { kind: 'sales', client: 'Koreyada', coach: ['Koreyadagilar uchun [narx]'] },
  { kind: 'sales', client: 'Biroz qimmatroq ekan', coach: ['Nimaga nisbatan qimmat aka? Keling hisoblaymiz', "N kunga bo'lsak kuniga [narx] chiqadi, bitta kofe puli. Buning evaziga shaxsiy ratsion, plan va har kuni nazorat"] },
  { kind: 'sales', client: 'Natijaga kafolat bormi?', coach: ["Mas'uliyat ikki tomonda aka. Men to'g'ri, ishlaydigan dastur beraman, siz amal qilasiz. Shunday qilsangiz natija o'zi keladi"] },
  { kind: 'sales', client: 'N kun davomida savollarim bo\'lsa kimga yozaman?', coach: ['Menga'] },
  { kind: 'sales', client: "Bo'lib to'lasa bo'ladimi?", coach: ["Yo'q aka, to'lov oldindan"] },
  { kind: 'sales', client: "Pulni qaytarish imkoni bormi, oxirigacha davom etolmasam?", coach: ["Qoidani buzib chiqarilsa qaytarilmaydi, guruh shartida shunaqa. Boshqa holat bo'lsa o'zim gaplashamiz", 'Boshlaymizmi?'] },
  { kind: 'sales', client: 'Ha, boshlaymiz', coach: ["Zo'r. Karta ma'lumotini tashlayman, to'lovdan keyin chekni yuborasiz"] },
  { kind: 'sales', client: '[chek rasmi]', coach: ['Rahmat aka, tekshirib guruh linkini tashlayman'] },
  { kind: 'sales', client: "O'ylab ko'raman", coach: ['Hop, shoshilmang', "Nima ikkilantiryapti, narxmi yo vaqtmi?"] },
];

/** Inserts the seed examples once (first start of a fresh database). Admin can disable/delete them in the mini app. */
export async function seedDefaultExamples(): Promise<number> {
  if (await StyleExample.exists({ source: 'seed' })) return 0;
  await StyleExample.insertMany(
    SEED_EXAMPLES.map((e) => ({ ...e, language: 'uz', source: 'seed', tokens: tokenize(`${e.client} ${e.coach.join(' ')}`) })),
  );
  logger.info({ count: SEED_EXAMPLES.length }, 'Seed style/sales examples inserted');
  return SEED_EXAMPLES.length;
}
