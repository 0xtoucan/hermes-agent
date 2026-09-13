import { commonEn } from "@hermes/shared/i18n-common";
import { describe, expect, it } from "vitest";

import { TRANSLATIONS } from "./context";
import type { Locale } from "./types";

type Node = Record<string, unknown>;

function leafPaths(node: unknown, prefix = ""): string[] {
  if (typeof node !== "object" || node === null) {
    return [prefix];
  }

  return Object.entries(node).flatMap(([key, value]) =>
    leafPaths(value, prefix ? `${prefix}.${key}` : key),
  );
}

function readPath(catalog: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, key) =>
        typeof node === "object" && node !== null
          ? (node as Node)[key]
          : undefined,
      catalog,
    );
}

describe("web catalog vs @hermes/shared/i18n-common", () => {
  const paths = leafPaths(commonEn);

  // English has no per-app overrides: a common key re-declared in web/en.ts
  // would shadow the spread and let the two apps' English drift apart again.
  it("resolves every common key to the shared English string", () => {
    expect(paths.length).toBeGreaterThan(0);

    for (const path of paths) {
      expect(readPath(TRANSLATIONS.en, path), path).toBe(
        readPath(commonEn, path),
      );
    }
  });

  // A locale may keep its own wording for a shared key (its override wins), but
  // it must never lose the translation: before the move every web locale
  // translated these keys itself, so falling back to English is a regression.
  it("translates every common key in every web locale", () => {
    for (const locale of Object.keys(TRANSLATIONS) as Locale[]) {
      if (locale === "en") {
        continue;
      }

      for (const path of paths) {
        const resolved = readPath(TRANSLATIONS[locale], path);

        expect(typeof resolved, `${locale}:${path}`).toBe("string");
        expect(resolved, `${locale}:${path} fell back to English`).not.toBe(
          readPath(commonEn, path),
        );
      }
    }
  });
});
