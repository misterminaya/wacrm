import { describe, expect, it } from "vitest";
import en from "../../../messages/en.json";
import { SETTINGS_SECTIONS } from "./settings-sections";

// Regression guard: every section id the rail renders must have a label in
// the locale file, or next-intl throws MISSING_MESSAGE at runtime (the rail
// calls t(`sections.${id}`) for each entry).
describe("settings i18n coverage", () => {
  const messages = en as Record<string, Record<string, unknown>>;

  it("has a Settings.sections label for every section id", () => {
    const sections = messages.Settings.sections as Record<string, string>;
    for (const id of SETTINGS_SECTIONS) {
      expect(sections[id], `missing Settings.sections.${id} in messages/en.json`).toBeDefined();
    }
  });

  it("has the Settings.roles entries the members UI renders", () => {
    const roles = messages.Settings.roles as Record<string, string>;
    for (const role of ["owner", "admin", "agent", "viewer"]) {
      expect(roles[role], `missing Settings.roles.${role}`).toBeDefined();
    }
  });
});
