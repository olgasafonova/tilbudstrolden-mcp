// Country-specific locale data for deal scoring and product matching.
// Each locale provides language-specific indicators, synonyms, and store maps.

export type CountryCode = "DK" | "NO" | "SE";

export interface Locale {
  country: CountryCode;
  countryName: string;
  currency: string;
  /** Currency symbol for display (kr, kr, kr — all Scandinavian) */
  currencySymbol: string;
  /** Processed food indicators — matched against offer headings */
  processedIndicators: string[];
  /** Raw/fresh food indicators — matched against offer headings */
  rawIndicators: string[];
  /** Non-ingredient headings to reject (ready meals, non-food, garden) */
  nonIngredientIndicators: string[];
  /** Prepositions indicating a modifier position in a heading */
  modifierPrepositions: string[];
  /** Ingredient synonym expansion for better deal matching */
  synonymMap: Record<string, string[]>;
  /** Dietary exclusion tag patterns mapped to ingredient names */
  ingredientTags: Record<string, string[]>;
  /** Well-known grocery stores: lowercase name -> dealer ID */
  knownStores: Record<string, string>;
  /** Bundle/or-separator patterns in headings */
  bundlePatterns: string[];
}

// ============================================================
// Danish (DK)
// ============================================================

const dk: Locale = {
  country: "DK",
  countryName: "Denmark",
  currency: "DKK",
  currencySymbol: "kr",

  processedIndicators: [
    "røget",
    "varmrøget",
    "koldrøget",
    "kold-",
    "marineret",
    "marinerede",
    "pålæg",
    "pålægssalat",
    "stegt",
    "paneret",
    "panerede",
    "gravad",
    "tørret",
    "dåse",
    "konserves",
    "salat",
    "postej",
    "leverpostej",
    "rullepølse",
    "spegepølse",
  ],

  rawIndicators: [
    "hakket",
    "filet",
    "hel ",
    "hele ",
    "fersk",
    "frossen",
    "frosne",
    "rå",
    "udskæring",
    "strimler",
    "terninger",
    "skiver",
    "udbenede",
    "bryst",
    "overlår",
    "underlår",
    "lår",
    "mørbrad",
    "nakke",
    "bov",
  ],

  nonIngredientIndicators: [
    "frø,",
    "frø ",
    "såfrø",
    "blomsterløg",
    "tærte",
    "omelet",
    "gratin",
    "gryderet",
    "færdigret",
    "risretter",
    "risret",
    "snack pot",
    "kopnudler",
    "instant ",
    "flødekartofler",
    "vaseline",
    "shampoo",
    "sæbe",
    "opvask",
    "sodavand",
    "energidrik",
    "skummetmælk",
    "pizza",
    "hundemad",
    "kattemad",
    "hundesnack",
  ],

  modifierPrepositions: [" i ", " med ", " og ", " på ", " til ", " fra "],

  synonymMap: {
    svinekød: ["grisekød", "grise-"],
    "hakket svinekød": ["hakket grisekød", "grise- og kalvekød"],
    svinefars: ["grisefars"],
    oksekød: ["okse-"],
    oksefars: ["hakket oksekød"],
    kyllingebryst: ["kylling"],
    kyllingefilet: ["kylling"],
    kyllingelår: ["kylling", "kyllingeunderlår"],
    kyllingestykker: ["kylling", "hel kylling"],
    rejer: ["skalrejer"],
  },

  ingredientTags: {
    pork: [
      "bacon",
      "chorizo",
      "salsiccia",
      "pølse",
      "wienerpølse",
      "flæsk",
      "flæskesteg",
      "brystflæsk",
      "svinekød",
      "svinekam",
      "svinekotelet",
      "grisekød",
      "grisefars",
      "svinefars",
      "mørbrad af gris",
    ],
    beef: ["oksekød", "oksemørbrad", "oksefars", "hakket okse"],
    lamb: ["lam", "lammekølle", "lammeculotte"],
    fish: ["laks", "fisk", "rødspætte", "torsk", "kuller", "tun", "sild"],
    shellfish: ["rejer", "hummer", "muslinger", "skalrejer"],
    dairy: [
      "mælk",
      "fløde",
      "piskefløde",
      "smør",
      "ost",
      "parmesan",
      "mozzarella",
      "creme fraiche",
      "yoghurt",
      "crème fraîche",
    ],
    gluten: [
      "mel",
      "hvedemel",
      "pasta",
      "spaghetti",
      "nudler",
      "ægnudler",
      "brød",
      "rugbrød",
      "lasagneplader",
      "tortilla",
      "rasp",
    ],
    beans: ["bønner", "kidneybønner", "linser", "kikærter"],
    nuts: ["cashewnødder", "mandler", "peanuts", "nødder", "hasselnødder"],
    egg: ["æg"],
  },

  knownStores: {
    netto: "9ba51",
    meny: "267e1m",
    lidl: "71c90",
    rema: "11deC",
    "rema 1000": "11deC",
    rema1000: "11deC",
    foetex: "bdf5A",
    føtex: "bdf5A",
    bilka: "93f13",
    spar: "88ddE",
    kvickly: "c1edq",
    "365discount": "DWZE1w",
    "365": "DWZE1w",
  },

  bundlePatterns: [" eller ", " el. "],
};

// ============================================================
// Norwegian (NO)
// ============================================================

const no: Locale = {
  country: "NO",
  countryName: "Norway",
  currency: "NOK",
  currencySymbol: "kr",

  processedIndicators: [
    "røkt",
    "røykt",
    "varmrøkt",
    "kaldrøkt",
    "marinert",
    "marinerte",
    "pålegg",
    "stekt",
    "panert",
    "panerte",
    "gravet",
    "tørket",
    "hermetikk",
    "boks",
    "salat",
    "postei",
    "leverpostei",
    "spekemat",
    "spekepølse",
    "spekeskinke",
  ],

  rawIndicators: [
    "kvernet",
    "filet",
    "hel ",
    "hele ",
    "fersk",
    "frossen",
    "frosne",
    "rå",
    "strimler",
    "terninger",
    "skiver",
    "bryst",
    "overlår",
    "underlår",
    "lår",
    "indrefilet",
    "nakke",
    "bog",
  ],

  nonIngredientIndicators: [
    "frø,",
    "frø ",
    "blomsterløk",
    "pai",
    "omelett",
    "grateng",
    "gryterett",
    "ferdigrett",
    "snack pot",
    "kopnudler",
    "instant ",
    "fløtegrateng",
    "vaselin",
    "sjampo",
    "såpe",
    "oppvask",
    "brus",
    "energidrikk",
    "pizza",
    "hundemat",
    "kattemat",
    "treningsbiter",
    "hundesnacks",
  ],

  modifierPrepositions: [" i ", " med ", " og ", " på ", " til ", " fra "],

  synonymMap: {
    svinekjøtt: ["grisekjøtt"],
    "kvernet svinekjøtt": ["kvernet grisekjøtt", "svinedeig"],
    svinedeig: ["grisekjøttdeig"],
    oksekjøtt: ["storfe"],
    oksedeig: ["kvernet oksekjøtt", "kjøttdeig"],
    kyllingfilet: ["kylling", "kyllingbryst"],
    kyllinglår: ["kylling"],
    reker: ["kokte reker", "rå reker"],
    laks: ["laksefilet"],
  },

  ingredientTags: {
    pork: [
      "bacon",
      "chorizo",
      "pølse",
      "wiener",
      "flesk",
      "svinekjøtt",
      "svinekoteletter",
      "grisekjøtt",
      "svinedeig",
      "svinestek",
      "ribbe",
      "indrefilet av svin",
    ],
    beef: ["oksekjøtt", "oksefilet", "oksedeig", "kjøttdeig", "biff"],
    lamb: ["lam", "lammestek", "lammelår"],
    fish: ["laks", "fisk", "torsk", "sei", "hyse", "tunfisk", "sild", "ørret"],
    shellfish: ["reker", "hummer", "blåskjell"],
    dairy: [
      "melk",
      "fløte",
      "kremfløte",
      "smør",
      "ost",
      "parmesan",
      "mozzarella",
      "rømme",
      "yoghurt",
    ],
    gluten: [
      "mel",
      "hvetemel",
      "pasta",
      "spaghetti",
      "nudler",
      "brød",
      "grovbrød",
      "lasagneplater",
      "tortilla",
    ],
    beans: ["bønner", "kidneybønner", "linser", "kikerter"],
    nuts: ["cashewnøtter", "mandler", "peanøtter", "nøtter", "hasselnøtter"],
    egg: ["egg"],
  },

  knownStores: {
    rema: "faa0Ym",
    "rema 1000": "faa0Ym",
    kiwi: "257bxm",
    meny: "4333pm",
    "coop prix": "f5d5lm",
    extra: "80742m",
    bunnpris: "5b11sm",
    obs: "51dawm",
    spar: "c062vm",
    joker: "b3e8Fm",
    gigaboks: "5vk-xt",
    holdbart: "pR2h9x",
  },

  bundlePatterns: [" eller ", " el. "],
};

// ============================================================
// Swedish (SE)
// ============================================================

const se: Locale = {
  country: "SE",
  countryName: "Sweden",
  currency: "SEK",
  currencySymbol: "kr",

  processedIndicators: [
    "rökt",
    "varmrökt",
    "kallrökt",
    "marinerad",
    "marinerade",
    "pålägg",
    "stekt",
    "panerad",
    "panerade",
    "gravad",
    "torkad",
    "konserv",
    "burk",
    "sallad",
    "korv",
    "falukorv",
    "medwurst",
  ],

  rawIndicators: [
    "mald",
    "malen",
    "filé",
    "hel ",
    "hela ",
    "färsk",
    "frusen",
    "frusna",
    "rå",
    "strimlad",
    "tärnad",
    "skivad",
    "bröst",
    "lår",
    "innerfilé",
    "ytterfilé",
    "bog",
  ],

  nonIngredientIndicators: [
    "frö,",
    "frö ",
    "blomsterlök",
    "paj",
    "omelett",
    "gratäng",
    "gryta",
    "färdigrätt",
    "snack pot",
    "instant ",
    "potatisgratäng",
    "vaselin",
    "schampo",
    "tvål",
    "diskmedel",
    "läsk",
    "energidryck",
    "pizza",
    "hundmat",
    "kattmat",
    "hundgodis",
  ],

  modifierPrepositions: [" i ", " med ", " och ", " på ", " till ", " från "],

  synonymMap: {
    fläskkött: ["griskött"],
    "malet fläskkött": ["malet griskött", "blandfärs"],
    fläskfärs: ["grisfärs", "blandfärs"],
    nötkött: ["nöt"],
    nötfärs: ["malet nötkött", "köttfärs"],
    kycklingfilé: ["kyckling", "kycklingbröst"],
    kycklinglår: ["kyckling"],
    räkor: ["skalräkor", "handskalade räkor"],
    lax: ["laxfilé"],
  },

  ingredientTags: {
    pork: [
      "bacon",
      "chorizo",
      "korv",
      "wiener",
      "fläsk",
      "fläskkött",
      "fläskfilé",
      "griskött",
      "fläskfärs",
      "kotlett",
      "revben",
    ],
    beef: ["nötkött", "nötfilé", "nötfärs", "köttfärs", "biff", "entrecôte"],
    lamb: ["lamm", "lammstek", "lammfärs"],
    fish: ["lax", "fisk", "torsk", "sej", "kolja", "tonfisk", "sill", "öring"],
    shellfish: ["räkor", "hummer", "musslor"],
    dairy: [
      "mjölk",
      "grädde",
      "vispgrädde",
      "smör",
      "ost",
      "parmesan",
      "mozzarella",
      "crème fraiche",
      "yoghurt",
      "gräddfil",
    ],
    gluten: [
      "mjöl",
      "vetemjöl",
      "pasta",
      "spaghetti",
      "nudlar",
      "bröd",
      "knäckebröd",
      "lasagneplattor",
      "tortilla",
    ],
    beans: ["bönor", "kidneybönor", "linser", "kikärtor"],
    nuts: ["cashewnötter", "mandlar", "jordnötter", "nötter", "hasselnötter"],
    egg: ["ägg"],
  },

  knownStores: {
    ica: "1d1dvA",
    "ica nära": "20d4lA",
    "ica supermarket": "1d1dvA",
    "ica kvantum": "9cb4wA",
    "ica maxi": "ca802A",
    willys: "c371GA",
    "willys hemma": "cJPBvX",
    hemköp: "d9b6XA",
    "city gross": "bfe5hA",
    coop: "63eeoD",
    "stora coop": "6c28SD",
    tempo: "1d73DD",
  },

  bundlePatterns: [" eller ", " el. "],
};

// ============================================================
// Registry
// ============================================================

const LOCALES: Record<CountryCode, Locale> = { DK: dk, NO: no, SE: se };

export function getLocale(country: string): Locale {
  const code = country.toUpperCase() as CountryCode;
  return LOCALES[code] ?? LOCALES.DK;
}

export function isValidCountry(country: string): country is CountryCode {
  return country.toUpperCase() in LOCALES;
}

export const SUPPORTED_COUNTRIES: CountryCode[] = ["DK", "NO", "SE"];
