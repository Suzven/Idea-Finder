import type { AdCreative, AdSource } from "../../src/shared/types.js";

const imageBase = "https://images.unsplash.com";
const videoUrl = "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4";

const campaigns = [
  {
    advertiser: "Noma Atelier",
    headline: "Форма, которая работает на вас",
    body: "Новая капсула для города: чистые линии, натуральные материалы и доставка за 48 часов.",
    cta: "Купить",
    image: `${imageBase}/photo-1529139574466-a303027c1d8b?auto=format&fit=crop&w=900&q=82`,
    country: "DE",
    language: "de",
  },
  {
    advertiser: "Aster Run Club",
    headline: "Лёгкость на каждом километре",
    body: "Амортизация нового поколения и посадка, которая поддерживает естественное движение стопы.",
    cta: "Подробнее",
    image: `${imageBase}/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=900&q=82`,
    country: "PL",
    language: "pl",
  },
  {
    advertiser: "Miro Skin Lab",
    headline: "Тихая сила ежедневного ухода",
    body: "Клинически проверенная формула с ниацинамидом для ровного тона и восстановления барьера кожи.",
    cta: "Заказать",
    image: `${imageBase}/photo-1556228578-0d85b1a4d571?auto=format&fit=crop&w=900&q=82`,
    country: "FR",
    language: "fr",
  },
  {
    advertiser: "North Standard",
    headline: "Время оставить только важное",
    body: "Механические часы из титана. Собраны вручную и защищены международной гарантией на пять лет.",
    cta: "Смотреть коллекцию",
    image: `${imageBase}/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=900&q=82`,
    country: "GB",
    language: "en",
  },
  {
    advertiser: "Onda Living",
    headline: "Пространство для новой привычки",
    body: "Модульная мебель, которую легко подстроить под ваш ритм, метраж и настроение.",
    cta: "Открыть каталог",
    image: `${imageBase}/photo-1555041469-a586c61ea9bc?auto=format&fit=crop&w=900&q=82`,
    country: "IT",
    language: "it",
  },
  {
    advertiser: "Kanso Audio",
    headline: "Слышать больше. Носить меньше.",
    body: "Пространственный звук, адаптивное шумоподавление и до 34 часов автономной работы.",
    cta: "Узнать больше",
    image: `${imageBase}/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=900&q=82`,
    country: "NL",
    language: "en",
  },
  {
    advertiser: "Field Notes Coffee",
    headline: "Утро начинается до первого глотка",
    body: "Свежая обжарка каждую среду. Выберите профиль, а мы подберём зерно под ваш способ заваривания.",
    cta: "Попробовать",
    image: `${imageBase}/photo-1495474472287-4d71bcdd2085?auto=format&fit=crop&w=900&q=82`,
    country: "ES",
    language: "es",
  },
  {
    advertiser: "Arc Studio",
    headline: "Свет меняет всё",
    body: "Коллекция портативных светильников с мягким сценарием пробуждения и управлением со смартфона.",
    cta: "Смотреть",
    image: `${imageBase}/photo-1507473885765-e6ed057f782c?auto=format&fit=crop&w=900&q=82`,
    country: "SE",
    language: "en",
  },
  {
    advertiser: "Forma Training",
    headline: "Двадцать минут, которые меняют день",
    body: "Персональные короткие тренировки дома — без сложного оборудования и жёстких ограничений.",
    cta: "Начать бесплатно",
    image: `${imageBase}/photo-1534438327276-14e5300c3a48?auto=format&fit=crop&w=900&q=82`,
    country: "PT",
    language: "pt",
  },
  {
    advertiser: "Luma Objects",
    headline: "Красота в полезных деталях",
    body: "Небольшие предметы для дома, созданные локальными мастерами из переработанных материалов.",
    cta: "В магазин",
    image: `${imageBase}/photo-1616486338812-3dadae4b4ace?auto=format&fit=crop&w=900&q=82`,
    country: "DK",
    language: "en",
  },
  {
    advertiser: "Serein Travel",
    headline: "Город, который вы ещё не видели",
    body: "Авторские маршруты, камерные отели и поддержка локального эксперта на протяжении всей поездки.",
    cta: "Выбрать маршрут",
    image: `${imageBase}/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=900&q=82`,
    country: "AT",
    language: "de",
  },
  {
    advertiser: "Plot Finance",
    headline: "Деньги любят ясность",
    body: "Все счета, цели и подписки в одном приложении. Понятная аналитика без таблиц и ручного ввода.",
    cta: "Скачать",
    image: `${imageBase}/photo-1556742049-0cfed4f6a45d?auto=format&fit=crop&w=900&q=82`,
    country: "IE",
    language: "en",
  },
];

const countryNames: Record<string, string> = {
  DE: "Германия", PL: "Польша", FR: "Франция", GB: "Великобритания",
  IT: "Италия", NL: "Нидерланды", ES: "Испания", SE: "Швеция",
  PT: "Португалия", DK: "Дания", AT: "Австрия", IE: "Ирландия",
};

function makeAds(source: AdSource): AdCreative[] {
  return campaigns.map((campaign, index) => {
    const startedAt = new Date(Date.UTC(2026, 6, 30 - index * 3));
    const daysActive = 5 + ((index * 7) % 68);
    const isVideo = source === "tiktok" || index % 4 === 1;
    const isCarousel = source === "meta" && index % 5 === 3;
    return {
      id: `${source}-${index + 1}`,
      source,
      advertiser: campaign.advertiser,
      country: campaign.country,
      countryName: countryNames[campaign.country] ?? campaign.country,
      platforms: source === "meta"
        ? index % 2 === 0 ? ["Facebook", "Instagram"] : ["Instagram", "Audience Network"]
        : ["TikTok"],
      mediaType: isCarousel ? "carousel" : isVideo ? "video" : "image",
      mediaUrl: isVideo ? videoUrl : campaign.image,
      thumbnailUrl: campaign.image,
      carousel: isCarousel ? [campaign.image, campaigns[(index + 1) % campaigns.length].image] : undefined,
      headline: campaign.headline,
      body: campaign.body,
      cta: campaign.cta,
      landingUrl: `https://example.com/campaign/${source}-${index + 1}`,
      sourceUrl: source === "meta" ? "https://www.facebook.com/ads/library/" : "https://library.tiktok.com/ads/",
      startedAt: startedAt.toISOString(),
      daysActive,
      reach: 18000 + index * 27300,
      savedCount: 8 + ((index * 17) % 143),
      language: campaign.language,
      appUrl: index % 3 === 0 ? "https://apps.apple.com/" : undefined,
    };
  });
}

export const demoAds: Record<AdSource, AdCreative[]> = {
  meta: makeAds("meta"),
  tiktok: makeAds("tiktok"),
};
