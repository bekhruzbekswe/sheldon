# Sheldon

> [English](./README.md) · **O'zbekcha**

Soatlab ishlaydigan tadqiqot agenti.

Siz unga savol va muddat berasiz. U sport zalida bo'lganingizda, uxlayotganingizda yoki boshqa uchrashuvda ekanligingizda ishlaydi. Qaytib kelganingizda, sizni iqtibos qilingan Markdown hisobot kutadi — va localhost'dagi panel u qilgan har bir qidiruv, da'vo va klasterlash qarorini ko'rsatadi.

Bitta mashinada, lokal LLM bilan ishlashga mo'ljallangan. Hech qanday cloud akkaunti talab qilinmaydi. Agent to'xtab qolsa, qolgan joyidan davom etadi. Har bir ish ikkita SQLite jadval va bitta JSONL log yordamida qayta tiklanadi.

---

```bash
bun run research "what changed in robotics foundation models in the last 6 months" --deadline 2h
```

Xohlasangiz, `http://127.0.0.1:4000` orqali kuzating. Yoki noutbukni yoping. Taymer tugaganda, sizda `report.md` bo'ladi: 4–7 ta tayanch da'vo, har biri bir nechta manba bilan tasdiqlangan, bullet'lar to'plami emas, analitik yozadigan abzatslar shaklida.

## Nima uchun bu kerak

Aksariyat "agent"lar hali ham chat shaklida. 30 soniya kutasiz, bitta javob olasiz, yana so'raysiz. "X uchun sintaksis qanday?" uchun bu yetarli. Ammo "buni men uchun tadqiq qilib ber" uchun yaroqsiz.

Haqiqiy tadqiqot sessiyasi shunday bo'ladi: dastlabki tezisni shakllantirish, dalil yig'ish, fikrni o'zgartirish, qayta yig'ish, ishlamagan qismlarni tashlab yuborish, oxirgi natijani yozish. Bu soatlar oladi. Yig'ishdan ko'ra ko'proq qisqartirishni o'z ichiga oladi. Sheldon — LLM'ga aynan shu shakldagi ishni berishga urinish; dalil, manba va "yaxshi javob qanday ko'rinishi kerak" haqida qat'iy qoidalar bilan.

## Qanday ishlaydi

```
savolingiz + muddat
   │
   ▼
breadth bosqichi   (~30% vaqt)  — savolni bo'lib, keng to'r tashlash
   │
depth bosqichi     (~50% vaqt)  — eng yaxshi yo'nalishlarga chuqurroq kirish
   │
synthesis bosqichi (~20% vaqt)  — qidiruv to'xtaydi. Tezis tuziladi. Har bir da'vo
                                  triangulyatsiya qilinadi. Har bir da'voga bo'lim
                                  yoziladi. Rubrikadan o'tmaganlari tashlab yuboriladi.
                                  Hisobot yig'iladi.
```

Holat ikkita SQLite jadvalda saqlanadi — bahosi qo'yilgan savollardan iborat **frontier navbati**, va embedding'lari hamda manba tasniflari bilan atomar da'volardan iborat **faktlar ombori**. Har bir qadam qo'shimcha JSONL hodisa logiga yoziladi. Alohida Hono jarayoni logni o'qib, localhost'dagi panelga SSE orqali uzatadi. Tadqiqot tsikli paneldan hech narsa o'qimaydi — panelni o'chirsangiz ham, qayta ishga tushirsangiz ham ish davom etaveradi.

To'liq arxitektura: [`docs/architecture.md`](./docs/architecture.md). Har bir imkoniyat shartnomasi: [`openspec/specs/`](./openspec/specs/).

## Tezkor start (~5 daqiqa)

Kerak bo'ladi: [Bun](https://bun.sh), OpenAI bilan mos LLM endpoint, va SearXNG instansiyasi.

```bash
git clone https://github.com/bekhruzbekswe/sheldon.git && cd sheldon
bun install
cp .env.example .env
$EDITOR .env   # LLM_BASE_URL va LLM_MODEL'ni OpenAI bilan mos endpoint'ga yo'naltiring
               # — llama.cpp, Ollama, vLLM, OpenRouter, Together — barchasi ishlaydi
```

SearXNG instansiyangiz yo'qmi? [searxng-docker](https://github.com/searxng/searxng-docker) repo'si ikki daqiqada bittasini beradi; `SEARXNG_BASE_URL`'ni unga yo'naltiring.

Keyin:

```bash
bun run research "what's actually new in fusion energy commercialization, 2024-2026" --deadline 30m
bun run dashboard   # boshqa terminalda — http://127.0.0.1:4000
```

Muddat tugaganda, hisobot `.sheldon/reports/<run-id>.md`'ga yoziladi (`latest.md` orqali ham mavjud). Jarayon ish o'rtasida to'xtab qolsa, `bun run research --resume` xuddi shu muddat, frontier va faktlar ombori bilan davom ettiradi.

## Panel

Bitta o'zicha yetarli `web/index.html` fayl. Vanilla JS, bundler yo'q, framework yo'q. Quyidagilarni ko'rsatadi:

- Hozirgi bosqich va qolgan vaqt
- Baho bo'yicha tartiblangan frontier navbati
- Mavzu tegi va manba tasnifi bo'yicha filtrlanadigan faktlar ombori
- Jonli hodisa oqimi: LLM chaqiriqlari, qidiruvlar, scrape'lar, fakt yozuvlari, bosqich o'tishlari, tashlab yuborilgan bo'limlar
- Synthesis boshlangach — tezis va qaysi da'volar bahsli ekanligi

Faqat o'qish, faqat localhost, faqat GET. GET'dan boshqasi 405 qaytaradi. Bu — boshqaruv markazi, oddiy foydalanuvchi UI'si emas.

## Uni o'zingizniki qiling

Eng qiziq sozlashlar tsiklga tegmasdan amalga oshiriladi:

- **Boshqa modeldan foydalaning.** `.env`'da `LLM_MODEL`'ni o'zgartiring. OpenAI bilan mos har qanday model ishlaydi.
- **Bosqichlarni o'zgartiring.** `0/30/80/100%` taqsimoti `src/phase.ts`'da.
- **Rubrikani tahrirlang.** Rubrikadan o'tmagan bo'limlarga bir marta qayta yozish imkoni beriladi, so'ng tashlab yuboriladi. Mezonlar `openspec/specs/section-rubric/spec.md` va `src/rubric.ts`'da.
- **Manbalarni qayta tasniflang.** Har bir scrape qilingan domen `rigorous / mixed / marketing / aggregator`'ga ajratiladi. Tasniflagich prompti `src/classify.ts`'da; tasniflar baho va triangulyatsiyaga ta'sir qiladi.
- **Hisobot shaklini o'zgartiring.** Hisobotni yig'uvchi `src/synthesize.ts`'da toza funksiyalardan iborat — kirish/xulosa shablonlarini almashtiring, iqtibos uslubini o'zgartiring, boshqa formatda render qiling.

Kattaroq sozlashlar yangi imkoniyat talab qiladi:

- Yangi dalil manbai (arXiv, Reddit, shaxsiy RSS'ingiz)
- Yangi bosqich (masalan, `verify` — depth va synthesis o'rtasida)
- Boshqa embedding modeli
- Brute-force cosine o'rniga `sqlite-vec`

Buning uchun ham workflow bor. `openspec new change <name>` proposal, design, specs delta va vazifalarni avtomatik tayyorlaydi. Batafsil: [`AGENTS.md`](./AGENTS.md).

## Texnologiyalar

- **Runtime** — Bun + TypeScript
- **LLM** — OpenAI bilan mos har qanday endpoint (llama.cpp ostidagi Qwen3.5-9B 32k ctx bilan ishlab chiqilgan; Ollama / OpenRouter bilan sinovdan o'tgan)
- **Embedding** — `@xenova/transformers` (`all-MiniLM-L6-v2`, jarayon ichida, Python kerak emas)
- **Qidiruv** — SearXNG
- **Scrape** — `@mozilla/readability` + `jsdom`
- **MB** — `bun:sqlite` (WAL)
- **Panel** — Hono + SSE, vanilla JS frontend

## Sifat haqida ochiqchasiga

Sheldon — ishlaydigan tizim, sehrli emas. Boshlashdan oldin bilishingiz kerak bo'lgan narsalar:

- **Hisobotlar "aqlli analitik qoralamasi" sifatida, "mutaxassis nashri" sifatida emas.** Ular tezisdan boshlanadi va iqtiboslar bilan himoyalanadi, lekin ba'zan qo'pol iqtibos zichligi (`[3][3][3]`) yoki kesilishi kerak bo'lgan bo'limni uchratasiz. Rubrika ko'pini ushlaydi. Hammasini emas.
- **`llm.deep` (fikrlash rejimi) hozircha o'chirilgan.** Qwen3.5-9B fikrlash rejimida butun output budget'ini `reasoning_content`'ga sarflaydi va 0 ta content token qaytaradi. Har bir chaqiruv `llm.fast`'dan foydalanadi. Hujjatlarda: [L0 izohlari](./docs/architecture.md). Boshqa modelni ulasangiz, deep mode bepulga qaytadi.
- **Vektor o'xshashligi JS'da brute-force cosine.** ~10k faktgacha yaxshi. Undan keyin `sqlite-vec`'ga o'tkazish kerak.
- **Beqaror upstream'lar uchun qayta urinish yo'q.** SearXNG xatosi yoki LLM endpoint'idan 502 bitta iteratsiyani tashlab yuboradi. Frontier oddiy davom etaveradi.

Yaxshi qiladigan tomonlari: soatlab vazifadan chetga chiqmaydi, sizning hardware'ingizdagi model bilan ishlaydi, hisobotdagi har bir da'vo URL'gacha kuzatiladi, butun ish bitta JSONL fayldan debug qilinadi, va halokat ishni yo'qotmaydi.

## Holat

| Versiya | Nima ishga tushirildi |
|---|---|
| **v1** (L0–L8) | Qatlamli qurilish: LLM client → hodisa logi → qidiruv tsikli → faktlar ombori → frontier navbati → bosqich mashinasi → synthesis → resume → panel. Savol + muddat → avtonom tadqiqot → iqtibos qilingan hisobot. |
| **v2** | Tadqiqot shartnomasi, manba tasniflagichi, tezisga asoslangan synthesis, gap analizatori, rubrika. Qatlam shaklini o'zgartirmasdan o'tkir hisobotlar. |

Kechiktirilgan, lekin hujjatlangan: iteratsiyalar davomida saqlanadigan **jonli gipoteza**, shunda yig'ish mavzuga asoslangan emas, e'tiqodga asoslangan bo'ladi. Qarang: [`docs/initiatives/living-hypothesis.md`](./docs/initiatives/living-hypothesis.md). Qiziqsangiz — ochiq taklif.

## Hissa qo'shish

[OpenSpec](https://github.com/Fission-AI/OpenSpec) atrofida qurilgan. Har bir imkoniyat barqaror spetsifikatsiyasi `openspec/specs/<capability>/`'da. Jarayondagi har bir o'zgarish `openspec/changes/<name>/` ichida proposal, design, specs delta va vazifalar bilan. Arxivlangan o'zgarishlar `openspec/changes/archive/`'da audit izini tashkil qiladi.

Yangi hissadorning birinchi PR'i odatda shunday ko'rinadi:

```bash
openspec new change <kebab-name>     # workspace'ni tayyorlaydi
# proposal, design, specs delta, vazifalarni tahrirlash
/opsx:apply <name>                   # amalga oshirish; vazifalarni bajarilganda belgilash
openspec validate <name>             # arxivlashdan oldin tekshirish
/opsx:archive <name>                 # spec'ni sinxronlaydi, archive/'ga ko'chiradi
```

[`AGENTS.md`](./AGENTS.md) — orientatsiya hujjati. AI coding sessiyalari uchun yozilgan, lekin odamlar uchun ham ravon o'qiladi.

## Litsenziya

[MIT](./LICENSE).
