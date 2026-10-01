import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ReferenceConjugation } from "../api/generated";
import { ReferenceConjugations } from "./ReferenceConjugations";

afterEach(cleanup);
const pronouns = ["ich", "du", "er_sie_es", "wir", "ihr", "sie_sie"] as const;
const tables = (): ReferenceConjugation[] => [
  { tense: "present", forms: pronouns.map((pronoun_group, index) => ({ pronoun_group,
    value: ["gehe", "gehst", "geht", "gehen", "geht", "gehen"][index], status: "applicable" })) },
  { tense: "preterite", forms: pronouns.map((pronoun_group, index) => ({ pronoun_group,
    value: ["ging", "gingst", "ging", "gingen", "gingt", "gingen"][index], status: "applicable" })) },
];

describe("two open reference conjugation tables", () => {
  it.each(["ru", "uk", "en"] as const)("shows both German tables in %s without an opening action or practice rights", language => {
    const input = tables(); const before = structuredClone(input);
    render(<ReferenceConjugations tables={input} language={language} />);
    expect(screen.getAllByRole("table")).toHaveLength(2);
    const present = screen.getByRole("table", { name: "Präsens" }), preterite = screen.getByRole("table", { name: "Präteritum" });
    expect(within(present).getAllByRole("row")).toHaveLength(6);
    expect(within(preterite).getAllByRole("row")).toHaveLength(6);
    expect(within(present).getByText("gehe")).toBeDefined();
    expect(within(preterite).getByText("gingst")).toBeDefined();
    expect(within(present).getByRole("rowheader", { name: "er / sie / es" })).toBeDefined();
    expect(within(present).getByRole("rowheader", { name: "sie / Sie" })).toBeDefined();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(input).toEqual(before);
  });
  it.each(["ru", "uk", "en"] as const)("localizes missing values in %s, while old absence is not inapplicability", language => {
    render(<ReferenceConjugations tables={[]} language={language} />);
    const label = { ru: "Не заполнено", uk: "Не заповнено", en: "Not filled in" }[language];
    expect(screen.getAllByText(label)).toHaveLength(12);
    expect(screen.getAllByText(label).every(node => node.lang === language)).toBe(true);
    expect(screen.getAllByRole("table")).toHaveLength(2);
  });
  it.each([null, "", " \n "])("marks a present but unfilled value %j without hiding its pronoun", value => {
    const input = tables(); input[0].forms[0].value = value;
    render(<ReferenceConjugations tables={input} language="ru" />);
    const row = within(screen.getByRole("table", { name: "Präsens" })).getByRole("rowheader", { name: "ich" }).closest("tr")!;
    expect(within(row).getByText("Не заполнено")).toBeDefined();
  });
  it("hides only explicitly inapplicable forms, preserving an unknown form and the other tense", () => {
    const input = tables(); input[0].forms[0] = { pronoun_group: "ich", value: null, status: "not_applicable" };
    input[0].forms[1] = { pronoun_group: "du", value: null, status: "unknown" };
    render(<ReferenceConjugations tables={input} language="ru" />);
    const present = screen.getByRole("table", { name: "Präsens" }), preterite = screen.getByRole("table", { name: "Präteritum" });
    expect(within(present).queryByRole("rowheader", { name: "ich" })).toBeNull();
    expect(within(present).getByRole("rowheader", { name: "du" })).toBeDefined();
    expect(within(present).getByText("Не заполнено")).toBeDefined();
    expect(within(preterite).getByRole("rowheader", { name: "ich" })).toBeDefined();
  });
  it("an entirely inapplicable tense is absent; the applicable one remains visible", () => {
    const input = tables(); input[0].forms = pronouns.map(pronoun_group => ({ pronoun_group, value: null, status: "not_applicable" }));
    render(<ReferenceConjugations tables={input} language="ru" />);
    expect(screen.queryByRole("table", { name: "Präsens" })).toBeNull();
    expect(screen.getByRole("table", { name: "Präteritum" })).toBeDefined();
  });
  it("a missing legacy tense stays visible instead of being mistaken for a closed practice block", () => {
    render(<ReferenceConjugations tables={[tables()[0]]} language="en" />);
    expect(within(screen.getByRole("table", { name: "Präteritum" })).getAllByText("Not filled in")).toHaveLength(6);
    expect(within(screen.getByRole("table", { name: "Präsens" })).queryByText("Not filled in")).toBeNull();
  });
  it("uses ordinary text for arbitrary data and replaces old forms when the card changes", () => {
    const input = tables(); input[0].forms[0].value = '<img src=x onerror="alert(1)">';
    const { container, rerender } = render(<ReferenceConjugations tables={input} language="ru" />);
    expect(screen.getByText(input[0].forms[0].value)).toBeDefined();
    expect(container.querySelector("img")).toBeNull();
    rerender(<ReferenceConjugations tables={tables()} language="ru" />);
    expect(screen.queryByText(input[0].forms[0].value)).toBeNull(); expect(screen.getByText("gehe")).toBeDefined();
  });
});
