import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "../locales/en.json";
import fr from "../locales/fr.json";

export const LANGUAGE_STORAGE_KEY = "app.language";

const stored = typeof localStorage !== "undefined" ? localStorage.getItem(LANGUAGE_STORAGE_KEY) : null;
const initialLng = stored === "en" || stored === "fr" ? stored : "fr";

void i18n.use(initReactI18next).init({
  resources: {
    fr: { translation: fr },
    en: { translation: en },
  },
  lng: initialLng,
  fallbackLng: "fr",
  interpolation: { escapeValue: false },
});

i18n.on("languageChanged", (lng) => {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, lng);
  }
  if (typeof document !== "undefined") {
    document.documentElement.lang = lng === "fr" ? "fr" : "en";
  }
});

if (typeof document !== "undefined") {
  document.documentElement.lang = initialLng === "fr" ? "fr" : "en";
}

export default i18n;
