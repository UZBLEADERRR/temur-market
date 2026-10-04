# TEMUR.FIT — Telegram AI-yordamchi (lead anketasi)

Instagram reklamasidan kelgan mijoz Temurning Telegram akkauntiga yozadi. Bot Telegram Business orqali **Temur nomidan va uning uslubida** 5 ta savol beradi. Javoblar yig'ilgach «Tushunarli» deb yozadi va shu chatda butunlay to'xtaydi. Shundan keyin Temur lead kartochkasini oladi va suhbatni o'zi davom ettiradi.

```
Instagram video → chat link → Temurning akkaunti → AI: 5 savol → «Tushunarli» [TAYYOR]
                                                  → kartochka adminga → Temur o'zi yozadi
```

Asosiy manba — texnik topshiriq (2-versiya) va system prompt v3.2. Prompt matnida murabbiy ismi `{{coach_name}}` (standart qiymati «Temur»).

## Nima qila oladi

| Imkoniyat | Qayerda |
|---|---|
| Telegram Business: xabarlar Temurning akkauntidan ketadi, javobdan oldin «yozmoqda…» ko'rinadi | `src/telegram/businessHandlers.ts` |
| 5 savollik holat mashinasi, javobi oldin kelgan savol qayta so'ralmaydi | `src/conversations/engine.ts`, `src/leads/questionnaire.ts` |
| Bo'y/vazn/yosh/kun parseri (`180/90/24`, `22 yoshman, 178 bo'y`, `Рост 175`…) | `src/leads/answerParser.ts` |
| TMI ni AI emas, backend hisoblaydi; 2-savol varianti TMI ga qarab tanlanadi | `src/leads/bmi.ts` |
| `[TAYYOR]` va `[TAYYOR: ehtiyot]`: belgi mijozga ko'rinmaydi, chat MANUAL rejimga o'tadi, kartochka yuboriladi | `engine.finishReady` |
| «Botmisiz?» savoliga rost javob, «Temur bilan gaplashmoqchiman», xavfli holatlar (ochlik, qusish…) | kalit so'zlar + LLM |
| Temur chatga o'zi yozsa, AI darhol o'chadi | `engine.handleCoachMessage` |
| 2 ta eslatma (≈1 soat va ≈20 soat, 24 soatlik oyna ichida) | `src/reminders/reminderService.ts` |
| Manbani aniqlash (`#v3` → `video_03`, `#video_03`, «2-videodan keldim») | `src/leads/sourceDetector.ts` |
| Temur uslubi: eski chatlar importi va anonimlashtirish, uslub profili, har so'rovga mos namunalar | `src/style/*` |
| Mijozning ovozli xabarini Gemini matnga aylantiradi | `AiService.transcribe` |
| Admin buyruqlari: `/navbat`, `/stats`, `/export` va barcha sozlamalar | `src/admin/adminCommands.ts` |
| **Mini ilova**: mijozlar jadvali, kartochka, «Chatni ochish», mijozga yozish, status, «Murabbiy haqida», sozlamalar, uslub, manbalar | `src/webapp/*` |

### Suhbat xulqi

- **Mijoz yozib bo'lishini kutadi.** Har yangi xabar taymerni qaytadan boshlaydi: oxirgi xabardan keyin 30 soniya, ovozli xabardan keyin +10 soniya, birinchi xabarda 12 soniya. Telegram botlarga "yozmoqda" holatini bermaydi, shuning uchun jimlik kutiladi. Bot javob yozayotganda mijoz yana yozsa, qolgan xabarlar yuborilmaydi va hammasiga birga javob beriladi.
- **Ovozli xabarlar** navbatdagi partiya bilan birga matnga aylantiriladi.
- **Avval maqsad aniqlanadi.** Reklama linkidan kelmagan va maqsadi aniq bo'lmagan mijozdan "Kurs bo'yicha yozyapsizmi?" deb so'raladi. Boshqa masalada bo'lsa, AI hech narsa yozmaydi, chat Temurga o'tadi va adminga xabar boradi.
- **Javobi bor savollar o'tkazib yuboriladi**, javob bir nechta xabar yoki ovozli xabarda kelgan bo'lsa ham.
- **Savollar AI'ning o'z so'zi bilan beriladi.** Tasdiq so'zlari almashib turadi (Aha, Zo'r, Hop…). Bir xil matn ketma-ket ikki marta yuborilmaydi.
- **Natijalar, kurs va narx haqidagi savollarga** AI "Murabbiy haqida", "Kurs haqida" va "O'quvchilar natijalari" ma'lumotlari bilan javob beradi va mijozni motivatsiya qiladi. U yerda yo'q narsani o'zidan to'qimaydi.
- **Anketa tugaganda** AI qisqa, tabiiy yakuniy xabar yozadi. Xavfli holatlarda faqat "Tushunarli" yuboriladi.

- **Maqsadni tushunadi.** Mijoz ozish, semirish, ozg'inlik, qomat yoki maslahat haqida yozsa, bot "kurs bo'yichami?" deb so'ramaydi: salomga javob beradi, uning gapiga javob beradi va 1-savolga o'tadi. Bu savol faqat mijoz shunchaki "Salom" yozganda beriladi. Kalit so'z bo'lmagan xabarlarni AI o'zi tasniflaydi. Turkcha klaviaturadagi harflar (ğ, ş) ham tushuniladi.
- **Rasmlar.** Qomat yoki ovqat rasmi yuborilsa, AI ularni ko'radi (bir javobda 3 tagacha) va hurmat bilan izoh beradi.
- **Spam himoyasi.** Faqat stiker yoki emoji kelsa javob berilmaydi. Partiyada 15 tadan ko'p xabar bo'lsa, faqat oxirgi 15 tasi olinadi. 5 daqiqada 40 tadan ko'p xabar kelsa, AI to'xtaydi va adminga xabar boradi.
- **Murabbiy maslahati.** Umumiy maslahatlar beradi: muntazamlik, oqsil, uyqu, suv. Shaxsiy ratsion va tibbiy maslahat bermaydi.
- **Ko'p foydalanuvchi.** grammY runner turli chatlarni parallel, bitta chatni esa ketma-ket ishlaydi. LLM so'rovlari navbat bilan cheklangan. Kutilmagan xatolar loglanadi va jarayonni to'xtatmaydi. Testda 150 ta mijoz bir vaqtda yozdi.
- **Mini ilova → mijoz kartochkasi:**
  - "🧹 Ma'lumotlarni tozalash" — bot shu mijoz bilan noldan boshlaydi;
  - "♾ AI doimiy" — anketadan keyin ham, Temur yozsa ham AI yordamchi sifatida javob beradi;
  - "🗑 O'chirish".

  Botda ham shunday buyruqlar bor: `/reset <id>`, `/always_on <id>`, `/always_off <id>`.

### Sotuv (anketadan keyin)

Bu oqim `sales_mode` sozlamasi yoqilganda ishlaydi (standart holatda yoqilgan).
1. 5 ta savol tugagach, Temurga "📋 ANKETA TUGADI — AI kursni sotyapti" kartochkasi keladi. Lead holati **SALES** (Sotuvda) bo'ladi.
2. AI mijozning javoblariga tayanib mos format taklif qiladi. Narx, tarif va to'lov ma'lumotini faqat "Kurs haqida" bo'limidan oladi. E'tirozlarga o'quvchilar natijalari bilan javob beradi va har xabarda bitta savol bilan suhbatni oldinga suradi.
3. Mijoz to'lov qilganini aytsa yoki chek skrinshotini yuborsa (AI rasmni ko'radi), AI minnatdorchilik bildiradi va "tekshirib, guruh linkini yuboraman" deydi. Shundan keyin to'xtaydi va Temurga **"💰 SOTILDI — guruh linkini yuboring"** kartochkasi keladi. Guruh linkini Temur o'zi yuboradi.
4. Mijoz rad etsa, AI xushmuomala xayrlashadi va "❌ Kursdan voz kechdi" kartochkasi keladi.
5. Bazada yo'q chegirma so'ralsa yoki mijoz Temurning o'zini so'rasa, chat Temurga o'tadi.
6. Sotuv skripti mini ilovada **Sozlamalar → AI → Sotuv skripti** bo'limida tahrirlanadi.
7. **Pulgacha olib borish.** Kod sotuv bosqichini kuzatib boradi:
   - birinchi sotuv xabari → taklif, **aniq narx** va yopish savoli;
   - mijoz rozi bo'lsa → **to'lov ma'lumoti** (mini ilovadagi matn so'zma-so'z yuboriladi) va chek so'raladi;
   - chek yoki "to'ladim" → SOLD.

   `max_sales_turns` (standart 4) ta javobdan keyin AI aniq yopish savoliga o'tadi: "To'lov ma'lumotini yuboraymi?".
8. Narx va to'lov ma'lumoti mini ilovadagi **"Murabbiy haqida" → "Narxlar va tariflar"** hamda **"To'lov ma'lumoti"** maydonlariga yoziladi. Narx kiritilmagan bo'lsa, adminga ogohlantirish keladi. Hammasi to'g'ri sozlanganini `/status` buyrug'i bilan tekshirish mumkin.

Sotuv bosqichidagi eslatma: "Qaror qildingizmi? Savollaringiz bo'lsa bemalol yozing".

### «O'ylab ko'raman», karta va sotuvdan keyin

- **«O'ylab ko'raman», «keyinroq», «maslahatlashay» desa:** AI bosim qilmaydi. Nima ikkilantirayotganini yumshoq so'raydi (narx, vaqt, ishonch, oila) va aynan shunga javob beradi.
- **Mijoz vaqt aytsa** («ertaga», «kechqurun»): AI «Hop, ertaga yozaman» deydi va o'sha vaqtda o'zi eslatma yozadi. Eslatmada mijoz nima deganini hisobga oladi.
  - Telegram qoidasi bo'yicha eslatma mijozning oxirgi xabaridan keyingi 24 soat ichida yuboriladi. Kechasi (22:00–09:00) yuborilmaydi.
  - Bitta mijozga ko'pi bilan 2 ta eslatma yuboriladi (`max_follow_ups`).
  - Mijoz o'zi yozsa, rejalashtirilgan eslatma bekor qilinadi.
- **Karta:** "To'lov ma'lumoti" maydoni bo'sh bo'lsa, AI "Kurs haqida" ichidagi karta raqami yozilgan qatorni (va yonidagi karta egasi qatorini) aynan o'zgartirmasdan yuboradi.
- **Sotuvdan keyin** (`ai_after_sale`, standart holatda yoqilgan): AI murabbiy yordamchisi sifatida yozishishni davom ettiradi. Guruh linkini va to'lov tasdig'ini baribir Temur o'zi beradi.
- **Rejimni almashtirish:** mini ilova → Sozlamalar → "Bot rejimi" → **📝 Faqat 5 savol** / **💰 Anketa + sotuv**. Botda: `/faqat_anketa`, `/sotuv_rejimi`.

### Temur o'zi yozsa

Standart holatda AI **to'xtamaydi**:
- Temurning xabari tarixda "Temur (O'ZI yozgan)" deb belgilanadi va AI uni ustun deb biladi: aytilgan narx, chegirma yoki ko'rsatmaga amal qiladi, unga zid gapirmaydi.
- Mijozning Temur javob bergan xabarlariga AI qayta javob bermaydi.

Eski xulq (Temur yozsa AI butunlay o'chadi) kerak bo'lsa, `coach_message_stops_ai` sozlamasini yoqing.

### Admin nimalarni o'zgartira oladi (kod yozmasdan)

Bot ichida (`/settings`, `/set`, `/prompt`) yoki mini ilovaning **Sozlamalar** bo'limida quyidagilarni o'zgartirish mumkin:
- system prompt va uslub profili;
- murabbiy ismi, **murabbiy haqida**, **kurs haqida** (narx ham bo'lishi mumkin) va **o'quvchilar natijalari** — AI savollarga faqat shu faktlar bilan javob beradi;
- "kurs bo'yichami?" savoli, tasdiq so'zlari, kutish vaqtlari;
- birinchi xabar, 2–5 savollar (UZ va RU);
- narx savoliga javob, «botmisiz?» savoliga javob, yakuniy «Tushunarli»;
- eslatma matnlari va vaqtlari;
- TMI chegaralari (25 / 21 / 18.5);
- xavfli holat, «Temurni so'rash» va «botmisiz» kalit so'zlari;
- LLM modeli va temperature, namunalar soni, «yozmoqda» tezligi;
- AI ni butunlay o'chirish (`ai_enabled`).

O'zgarishlar MongoDB'ga saqlanadi va bir zumda kuchga kiradi.

### Halollik
AI Temur nomidan yozadi va o'zini yordamchi deb tanishtirmaydi. Lekin mijoz jiddiy «botmisiz?» deb so'rasa, topshiriqning 7-bandi bo'yicha rost javob beradi: «Ha, savollarga AI-yordamchim javob beryapti, lekin hammasini o'zim ko'rib turibman. Hozir o'zim yozaman.» Shundan keyin chat Temurga o'tadi. AI hech qachon «bot emasman» deb yozmaydi.

---

## 1. Telegram tayyorgarligi

1. Temurning akkauntida **Telegram Premium** bo'lishi shart: Business funksiyalari faqat Premium'da ishlaydi.
2. Temurning Telegram ID raqamini bilib oling (masalan, @userinfobot orqali). U `TEMUR_TELEGRAM_ID` va `TELEGRAM_ADMIN_ID` ga yoziladi.

## 2. BotFather

1. @BotFather → `/newbot` → token oling. U `TELEGRAM_BOT_TOKEN` ga yoziladi.
2. @BotFather → `/mybots` → bot → **Bot Settings → Business Mode → Turn on**.

## 3. Telegram Business Mode

Temurning akkauntida **Settings → Telegram Business → Chatbots** (Chat Automation) bo'limini oching:
1. Bot username'ini kiriting.
2. **Ruxsat:** faqat **yangi chatlar** (eski mijozlarga AI yozmasligi uchun). Mavjud chatlarni chiqarib tashlang.
3. **«Reply to messages» / xabarlarga javob berish** ruxsatini yoqing.

**Telegram Business → Greeting message** ni o'chiring, chunki birinchi xabarni AI yuboradi.

Telegram ilovasida botni muayyan chatda **pauza** qilish mumkin. Pauzadan keyin yuborishga urinish xato beradi va AI shu chat uchun o'chadi.

## 4. Business connection

Bot ulanganda Telegram `business_connection` yangilanishini yuboradi. Bot uni bazaga saqlaydi va adminga «🔗 Telegram Business ulandi» deb yozadi. Agar javob berish ruxsati berilmagan bo'lsa, ogohlantirish yuboradi. Har bir javob shu `business_connection_id` bilan yuboriladi, shuning uchun mijoz uni Temurdan kelgan xabar deb ko'radi.

**Reklama linklari.** Har bir video uchun **Telegram Business → Links to Chat** bo'limida alohida link yarating. Linkning tayyor xabariga kod qo'shing, masalan `Salom! #v3`. Keyin botga quyidagi buyruqni yuboring:
```
/campaign_add #v3 video_03
```
yoki kodni mini ilovaning **Manbalar** bo'limida qo'shing. Kodsiz `#video_03` heshtegi ham to'g'ridan-to'g'ri manba sifatida olinadi. Kod mijozga ham, AI ga ham ko'rinmaydi.

**Muhim:** Temur (va boshqa adminlar) botning o'zida `/start` bosishi kerak. Aks holda bot ularga kartochka yubora olmaydi.

## 5. MongoDB

- **Lokal:** `docker compose up -d mongo`
- **Railway:** loyihaga **MongoDB** servisini qo'shing va bot servisida `MONGODB_URI=${{MongoDB.MONGO_URL}}` qilib bog'lang.
- **Atlas:** connection string'ni `MONGODB_URI` ga qo'ying.

Kolleksiyalar: `leads` (lead + suhbat holati), `messages`, `settings`, `style_examples`, `style_profiles`, `campaigns`, `reminders`, `admin_events`, `business_connections`, `processed_updates` (idempotentlik uchun, 14 kunlik TTL).

## 6. LLM (Gemini)

1. https://aistudio.google.com → **Get API key**. Kalitni `LLM_API_KEY` ga yozing.
2. `LLM_MODEL=gemini-3.8-flash`. Modelni mini ilovadagi `llm_model` sozlamasi orqali ham almashtirish mumkin.

Model faqat JSON qaytaradi va backend uni Zod bilan tekshiradi. Noto'g'ri javob mijozga yuborilmaydi: 3 marta qayta urinadi, ketma-ket xatolarda adminga xabar boradi, keyin har 2 daqiqada yana urinadi.

## 7. Environment o'zgaruvchilari

`.env.example` ni `.env` ga nusxalang.

| O'zgaruvchi | Izoh |
|---|---|
| `TELEGRAM_BOT_TOKEN` | BotFather token |
| `TELEGRAM_ADMIN_ID` | Kartochka oladigan va admin bo'lgan ID'lar (vergul bilan) |
| `TEMUR_TELEGRAM_ID` | Temurning ID si (admin ham bo'ladi) |
| `MONGODB_URI` | MongoDB |
| `LLM_API_KEY`, `LLM_MODEL` | Gemini |
| `PUBLIC_URL` | Mini ilova uchun https manzil. Railway'da `RAILWAY_PUBLIC_DOMAIN` avtomatik olinadi |
| `BOT_MODE` | `polling` (standart) yoki `webhook` |
| `WEBHOOK_SECRET` | Webhook rejimi uchun maxfiy so'z |
| `ADMIN_WEB_TOKEN` | Ixtiyoriy: mini ilovani oddiy brauzerda `?token=` bilan ochish |
| `TZ_NAME` | `/stats` uchun vaqt zonasi (standart `Asia/Tashkent`) |

Kodda hech qanday sir yozilmagan.

## 8. Temurning eski chatlarini import qilish

1. Telegram Desktop → chat → ⋮ → **Export chat history** → format **HTML** yoki **JSON** → matn yetarli, media shart emas.
2. Faylni (`messages.html` yoki `result.json`) **botga hujjat qilib yuboring**. Bir nechta `messages2.html` fayl bo'lsa, har birini alohida yuboring.
   CLI orqali ham mumkin: `npm run import:chats -- messages.html result.json`
3. Bot javobida: «Import: N chat, M xabar → K ta anonim namuna».

Temur kimligi `TEMUR_TELEGRAM_ID` bo'yicha (JSON), aks holda «chat sarlavhasidagi odam emas» qoidasi bo'yicha (HTML) aniqlanadi.

## 9. Anonimlashtirish

Import paytida avtomatik bajariladi (`src/style/anonymizer.ts`):
- ismlar, @username, telefon, karta raqami, email va linklar `[ism]`, `[telefon]`, `[karta]` kabi belgilarga almashtiriladi;
- mijoz matnidagi barcha raqamlar `N` bilan almashtiriladi (vazn, yosh qolmaydi);
- sog'liq atamalari `[sog'liq]` bo'ladi;
- Temurning narx, chegirma, to'lov, raqamli va'da yoki uzun ratsion yozilgan javoblari **butunlay tashlab yuboriladi**.

Natijani mini ilovaning **Uslub** bo'limida ko'rib chiqing. Keraksiz namunani o'chiring yoki vaqtincha yopib qo'ying. U yerda qo'lda yangi namuna ham qo'shish mumkin.

## 10. Temur uslub profili

- Standart profil Temurning haqiqiy yozishmalaridan qo'lda tuzilgan. U mijoz ma'lumotlarini o'z ichiga olmaydi.
- `/style_rebuild` (yoki mini ilovadagi tugma) statistikani hisoblaydi: gap uzunligi, emoji, tez-tez ishlatiladigan iboralar. Keyin Gemini yangi profil yozadi va u `style_profile` sozlamasiga tushadi. Uni qo'lda tahrirlash mumkin.
- **Ovozli namunalar:** botga ovozli xabar yuboring. Transkript `voice_style_notes` ga qo'shiladi va ikkilamchi uslub manbai sifatida ishlatiladi.
- Har bir LLM so'roviga quyidagilar yuboriladi: prompt, uslub profili, eng mos 20 ta namuna, lead holati, oxirgi 20 xabar, TMI va kerak bo'lsa suhbat xulosasi. Butun tarix yuborilmaydi.

## 11. Lokal ishga tushirish

```bash
npm install
docker compose up -d mongo
cp .env.example .env   # to'ldiring
npm run dev
```
Testlar (MongoDB kerak, standart `mongodb://127.0.0.1:27017/temur_fit_test`, yoki `TEST_MONGODB_URI`):
```bash
npm test
npm run typecheck
```
Haqiqiy Gemini bilan 14 ta stsenariy (A–O, Telegramsiz, xabarlar konsolga chiqadi; alohida test bazasidan foydalaning):
```bash
MONGODB_URI=mongodb://127.0.0.1:27017/temur_sim npm run simulate        # hammasi
MONGODB_URI=mongodb://127.0.0.1:27017/temur_sim npm run simulate -- F   # faqat «botmisiz?»
```

## 12. Docker

```bash
cp .env.example .env
docker compose up -d --build
curl localhost:3000/health
```

## 13. Production — Railway

1. Railway → **New Project → Deploy from GitHub repo** → `temur-market`. `railway.json` Dockerfile orqali build qiladi.
2. **+ New → Database → MongoDB**. Bot servisida `MONGODB_URI=${{MongoDB.MONGO_URL}}` qo'shing.
3. Bot servisi → **Variables** bo'limiga `.env.example` dagi qiymatlarni kiriting.
4. **Settings → Networking → Generate Domain**. Mini ilova manzili `https://<domain>/app/` bo'ladi.
5. **Replicas = 1** qoldiring: polling rejimida ikkita nusxa bir-biriga xalaqit beradi.
6. Deploy bo'lgach botda `/start` bosing. Pastki chapda **«Mijozlar»** menyu tugmasi paydo bo'ladi (mini ilova).

Webhook kerak bo'lsa: `BOT_MODE=webhook`, `WEBHOOK_SECRET=<tasodifiy>`. Webhook `https://<domain>/telegram/webhook` manzilida o'rnatiladi.

## 14. Monitoring

- `GET /health` — Railway healthcheck uchun.
- Strukturali JSON loglar (pino) yoziladi: kiruvchi va chiquvchi xabar, AI so'rovi metama'lumoti (model, ms, tokenlar), holat o'zgarishi, `[TAYYOR]`, manual takeover, eslatmalar, xatolar. Mijoz matni va maxfiy kalitlar loglarga yozilmaydi.
- Adminga avtomatik xabarlar: yangi lead kartochkasi, 🔴 shoshilinch lead, AI ishlamay qolgani, Business ulanish holati.
- `admin_events` kolleksiyasi audit uchun.

## 15. Backup

- **Railway MongoDB:** servis → **Backups** (yoqib qo'ying) yoki muntazam `mongodump`:
  ```bash
  mongodump --uri "$MONGODB_URI" --archive=backup_$(date +%F).gz --gzip
  mongorestore --uri "$MONGODB_URI" --archive=backup_2026-10-02.gz --gzip
  ```
- Leadlarni Excel'ga tez saqlash: `/export`.

---

## Admin buyruqlari

```
/navbat            javob kutayotganlar (shoshilinchlar va eng eskisi birinchi)
/stats [YYYY-MM-DD] kunlik statistika
/export /export_csv Excel / CSV
/lead <id|@user>   kartochka
/ai_off <id> /ai_on <id>   chatda AI ni o'chirish / qayta yoqish
/ai_global_off /ai_global_on
/settings /get <kalit> /set <kalit> [qiymat] /reset_setting <kalit>
/reset <id>        mijoz ma'lumotlarini tozalash
/always_on <id> /always_off <id>
/prompt            promptni .txt qilib oladi, keyingi xabar/fayl — yangi prompt
/style /style_rebuild /examples /examples_clear
/campaigns /campaign_add <kod> <manba> /campaign_del <kod>
```
Kartochkadagi tugmalar: **✅ Javob berildi / 💰 To'ladi / ❌ Rad etdi / 💬 Chatni ochish / 📋 Ilovada ochish**.
Temur chatga o'zi yozsa, status avtomatik «Javob berildi» bo'ladi.

## Holatlar

`NEW → QUESTIONNAIRE → READY → ANSWERED → PAID / REJECTED`, rejim `AI | MANUAL`.
`[TAYYOR]` holatida `status=READY` va `mode=MANUAL` qo'yiladi. Shundan keyin bu chatga hech qanday avtomatik xabar yoki eslatma ketmaydi. AI ni faqat admin qo'lda qayta yoqishi mumkin.

## Cheklovlar

- Telegram qoidasi bo'yicha akkaunt nomidan faqat oxirgi 24 soatda faol bo'lgan chatga yozish mumkin. Eslatmalar shu oyna ichida yuboriladi.
- Mijozda @username bo'lmasa, mini ilovadagi «Chatni ochish» tugmasi botga bosiladigan havola yuboradi. Temurning o'z akkauntida bu chat baribir ro'yxatda bor.
- Mini ilovadan yozish ham Temurning akkauntidan ketadi va AI ni o'chiradi.
