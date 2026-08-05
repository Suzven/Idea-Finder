export interface FilterOption {
  value: string;
  label: string;
}

const META_COUNTRY_CODES = `BR IN GB US CA AR AU AT BE CL CN CO HR DK DO EG FI FR DE GR HK ID IE IL IT JP JO KW LB MY MX NL NZ NG NO PK PA PE PH PL RU SA RS SG ZA KR ES SE CH TW TH TR AE VE PT LU BG CZ SI IS SK LT TT BD LK KE HU MA CY JM EC RO BO GT CR QA SV HN NI PY UY PR BA PS TN BH VN GH MU UA MT BS MV OM MK LV EE IQ DZ AL NP MO ME SN GE BN UG GP BB AZ TZ LY MQ CM BW ET KZ NA MG NC MD FJ BY JE GU YE ZM IM HT KH AW PF AF BM GY AM MW AG RW GG GM FO LC KY BJ AD GD VI BZ VC MN MZ ML AO GF UZ DJ BF MC TG GL GA GI CD KG PG BT KN SZ LS LA LI MP SR SC VG TC DM MR AX SM SL NE CG AI YT CV GN TM BI TJ VU SB ER WS AS FK GQ TO KM PW FM CF SO MH VA TD KI ST TV NR RE LR ZW CI MM AN AQ BQ BV IO CX CC CK CW TF GW HM XK MS NU NF PN BL SH MF PM SX GS SS SJ TL TK UM WF EH SY`.split(" ");

const META_LANGUAGE_CODES = `aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu cmn yue`.split(" ");

const countryFallbacks: Record<string, string> = {
  AN: "Нидерландские Антильские острова",
  BQ: "Карибские Нидерланды",
  BV: "Остров Буве",
  CC: "Кокосовые острова",
  CD: "Демократическая Республика Конго",
  CI: "Кот-д’Ивуар",
  CX: "Остров Рождества",
  FK: "Фолклендские острова",
  FM: "Микронезия",
  GS: "Южная Георгия и Южные Сандвичевы острова",
  HM: "Острова Херд и Макдональд",
  IO: "Британская территория в Индийском океане",
  MF: "Сен-Мартен",
  MM: "Мьянма",
  PN: "Острова Питкэрн",
  PS: "Палестина",
  SH: "Остров Святой Елены",
  SJ: "Шпицберген и Ян-Майен",
  SX: "Синт-Мартен",
  TF: "Французские Южные территории",
  TL: "Восточный Тимор",
  UM: "Внешние малые острова США",
  VA: "Ватикан",
  VG: "Британские Виргинские острова",
  VI: "Виргинские острова США",
  XK: "Косово",
};

const languageFallbacks: Record<string, string> = {
  aa: "Афарский",
  ab: "Абхазский",
  ae: "Авестийский",
  av: "Аварский",
  ba: "Башкирский",
  bi: "Бислама",
  bo: "Тибетский",
  ce: "Чеченский",
  ch: "Чаморро",
  cmn: "Китайский (мандарин)",
  cr: "Кри",
  cu: "Церковнославянский",
  cv: "Чувашский",
  dz: "Дзонг-кэ",
  ff: "Фула",
  fj: "Фиджийский",
  gv: "Мэнский",
  ho: "Хири-моту",
  hz: "Гереро",
  ie: "Интерлингве",
  ii: "Носу",
  ik: "Инупиак",
  io: "Идо",
  iu: "Инуктитут",
  kg: "Конго",
  ki: "Кикуйю",
  kj: "Кваньяма",
  kl: "Гренландский",
  kr: "Канури",
  ks: "Кашмири",
  kv: "Коми",
  kw: "Корнский",
  li: "Лимбургский",
  lu: "Луба-катанга",
  mh: "Маршалльский",
  na: "Науру",
  nd: "Северный ндебеле",
  ng: "Ндонга",
  nr: "Южный ндебеле",
  nv: "Навахо",
  oj: "Оджибве",
  os: "Осетинский",
  pi: "Пали",
  rn: "Рунди",
  sc: "Сардинский",
  se: "Северносаамский",
  sg: "Санго",
  ss: "Свати",
  tw: "Тви",
  ty: "Таитянский",
  ve: "Венда",
  vo: "Волапюк",
  yue: "Китайский (кантонский)",
  za: "Чжуанский",
};

function displayName(type: "region" | "language", code: string, fallbacks: Record<string, string>): string {
  if (fallbacks[code]) return fallbacks[code];
  try {
    return new Intl.DisplayNames(["ru"], { type }).of(code) ?? code;
  } catch {
    return code;
  }
}

function localizedOptions(codes: string[], type: "region" | "language", fallbacks: Record<string, string>): FilterOption[] {
  return codes
    .map((value) => ({ value, label: displayName(type, value, fallbacks) }))
    .sort((left, right) => left.label.localeCompare(right.label, "ru"));
}

export const META_COUNTRIES = [{ value: "ALL", label: "Все страны" }, ...localizedOptions(META_COUNTRY_CODES, "region", countryFallbacks)];
export const META_LANGUAGES = localizedOptions(META_LANGUAGE_CODES, "language", languageFallbacks);
