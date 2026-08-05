import { describe, expect, it } from "vitest";
import { META_COUNTRIES, META_LANGUAGES } from "../src/shared/filterOptions.js";

describe("Meta filter options", () => {
  it("contains the complete country list and keeps ALL available", () => {
    expect(META_COUNTRIES).toHaveLength(248);
    expect(META_COUNTRIES).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: "ALL" }),
      expect.objectContaining({ value: "US" }),
      expect.objectContaining({ value: "UA" }),
      expect.objectContaining({ value: "XK" }),
    ]));
  });

  it("contains ISO 639-1 languages plus Mandarin and Cantonese", () => {
    expect(META_LANGUAGES).toHaveLength(186);
    expect(META_LANGUAGES).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: "en" }),
      expect.objectContaining({ value: "uk" }),
      expect.objectContaining({ value: "cmn" }),
      expect.objectContaining({ value: "yue" }),
    ]));
    expect(META_LANGUAGES.every((option) => option.label.toLocaleLowerCase("ru") !== option.value)).toBe(true);
  });
});
