import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Topic } from "../api/generated";
import { TopicsPicker } from "./TopicsPicker";

const id = (n: number) => `abcdef00-0000-4000-8000-${String(n).padStart(12, "0")}`;
const topics: Topic[] = [
  { id: id(1), number: 1, german_name: "Über Größen", description: "Die vollständige Beschreibung\nMit einer zweiten Zeile" },
  { id: id(2), number: 7, german_name: "Küche", description: "Essen und Trinken" },
  { id: id(3), number: 12, german_name: "Äpfel und Öl", description: "Obst und Lebensmittel" },
  { id: id(4), number: 25, german_name: "Straße", description: "In der Stadt" },
];
afterEach(cleanup);
function mount(selected: string[] = [id(1)], disabled = false) {
  const onChange = vi.fn();
  const result = render(<TopicsPicker topics={topics} selected={selected} language="ru" disabled={disabled} onChange={onChange} />);
  return { ...result, onChange };
}
function search(value: string) { fireEvent.change(screen.getByRole("searchbox"), { target: { value } }); }

describe("topic selection", () => {
  it("renders the real descriptions without trimming, translating, or executing HTML", () => {
    const description = `${topics[0].description}\n<script>window.synthetic = true</script>\n${"Полный текст. ".repeat(150)}`;
    const data = [{ ...topics[0], description }];
    const { container } = render(<TopicsPicker topics={data} selected={[]} language="ru" onChange={vi.fn()} />);
    expect(container.querySelector(".topics-description")?.textContent).toBe(description);
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByRole("checkbox", { name: "1. Über Größen" }).getAttribute("aria-describedby"))
      .toContain("description");
  });

  it.each([
    ["1", ["1. Über Größen", "12. Äpfel und Öl"]],
    ["7", ["7. Küche"]],
    ["ueber", ["1. Über Größen"]],
    ["GRÖSSEN", ["1. Über Größen"]],
    ["groessen", ["1. Über Größen"]],
    ["ku\u0308che", ["7. Küche"]],
    ["  KUECHE  ", ["7. Küche"]],
    ["aepfel und oel", ["12. Äpfel und Öl"]],
    ["strasse", ["25. Straße"]],
    ["straße", ["25. Straße"]],
  ])("finds %s by number or normalized German name", (query, names) => {
    const f = mount(); search(query);
    expect(screen.getAllByRole("checkbox").map(input => {
      const label = document.getElementById(input.getAttribute("aria-labelledby")!);
      return label?.textContent;
    })).toEqual(names);
    expect(f.onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("Выбрано: 1 из 4");
  });

  it("does not search description text or change the selection after no results", () => {
    const f = mount(); search("vollständige Beschreibung");
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getByText("Темы не найдены. Измени поисковый запрос.")).toBeDefined();
    expect(screen.getByRole("status").textContent).toContain("Выбрано: 1 из 4. Найдено: 0");
    expect(f.onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Очистить поиск" }));
    expect(screen.getAllByRole("checkbox")).toHaveLength(4);
    expect((screen.getByRole("checkbox", { name: "1. Über Größen" }) as HTMLInputElement).checked).toBe(true);
    expect(f.onChange).not.toHaveBeenCalled();
  });

  it("cannot deselect the last chosen topic", () => {
    const f = mount(); const last = screen.getByRole("checkbox", { name: "1. Über Größen" }) as HTMLInputElement;
    expect(last.disabled).toBe(true); fireEvent.click(last); expect(f.onChange).not.toHaveBeenCalled();
    expect(last.getAttribute("aria-describedby")).toContain("minimum");
  });

  it("allows selecting the first topic, then changing the nonempty selection", () => {
    const changed = vi.fn();
    function Editor() {
      const [selected, setSelected] = useState<string[]>([]);
      return <TopicsPicker topics={topics} selected={selected} language="ru" onChange={ids => { changed(ids); setSelected(ids); }} />;
    }
    render(<Editor />);
    const first = screen.getByRole("checkbox", { name: "1. Über Größen" }) as HTMLInputElement;
    const second = screen.getByRole("checkbox", { name: "7. Küche" }) as HTMLInputElement;
    expect(first.disabled).toBe(false); fireEvent.click(first);
    expect(changed).toHaveBeenLastCalledWith([id(1)]); expect(first.disabled).toBe(true);
    fireEvent.click(second); expect(changed).toHaveBeenLastCalledWith([id(1), id(2)]); expect(first.disabled).toBe(false);
    fireEvent.click(first); expect(changed).toHaveBeenLastCalledWith([id(2)]); expect(second.disabled).toBe(true);
  });

  it("selects the whole catalog even while search shows only a subset", () => {
    const f = mount([]); search("Küche"); fireEvent.click(screen.getByRole("button", { name: "Выбрать все темы" }));
    expect(f.onChange).toHaveBeenCalledExactlyOnceWith(topics.map(topic => topic.id));
    const onChange = vi.fn(); f.rerender(<TopicsPicker topics={topics} selected={topics.map(topic => topic.id)} language="ru" onChange={onChange} />);
    expect((screen.getByRole("button", { name: "Выбрать все темы" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("Küche");
    expect(screen.getByRole("status").textContent).toContain("Выбрано: 4 из 4. Найдено: 1");
  });

  it("keeps search and the same scroll container when selection or incoming catalog changes", () => {
    const f = mount(); search("ü");
    const list = screen.getByRole("group", { name: "Список тем" }); list.scrollTop = 137;
    fireEvent.click(screen.getByRole("checkbox", { name: "7. Küche" }));
    f.rerender(<TopicsPicker topics={structuredClone(topics)} selected={[id(1), id(2)]} language="ru" onChange={f.onChange} />);
    expect(screen.getByRole("group", { name: "Список тем" })).toBe(list); expect(list.scrollTop).toBe(137);
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("ü");
    expect(list.getAttribute("tabindex")).toBe("0");
  });

  it("does not treat UUID case as a different selection", () => {
    const f = mount([id(1).toUpperCase(), id(2)]);
    const first = screen.getByRole("checkbox", { name: "1. Über Größen" }) as HTMLInputElement;
    expect(first.checked).toBe(true); fireEvent.click(first);
    expect(f.onChange).toHaveBeenLastCalledWith([id(2)]);
  });

  it("blocks edits to an incomplete catalog without dropping unknown selections or printing IDs", () => {
    const f = mount([id(1), id(99)]);
    expect(screen.getByRole("alert").textContent).toContain("Обнови настройки");
    expect(document.body.textContent).not.toContain(id(99));
    for (const box of screen.getAllByRole("checkbox")) expect((box as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Выбрать все темы" }) as HTMLButtonElement).disabled).toBe(true);
    expect(f.onChange).not.toHaveBeenCalled();
    f.rerender(<TopicsPicker topics={[...topics, { id: id(99), number: 99, german_name: "Neu", description: "Neu geladen" }]}
      selected={[id(1), id(99)]} language="ru" onChange={f.onChange} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("checkbox", { name: "99. Neu" }) as HTMLInputElement).checked).toBe(true);
  });

  it("allows searching while pending but cannot modify the draft", () => {
    const f = mount([id(1)], true); search("Küche");
    const checkbox = screen.getByRole("checkbox", { name: "7. Küche" }) as HTMLInputElement;
    expect(checkbox.disabled).toBe(true); fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: "Выбрать все темы" })); expect(f.onChange).not.toHaveBeenCalled();
  });

  it("renders an empty catalog distinctly from unsuccessful search", () => {
    render(<TopicsPicker topics={[]} selected={[]} language="ru" onChange={vi.fn()} />);
    expect(screen.getByText("Тем пока нет")).toBeDefined();
    expect((screen.getByRole("button", { name: "Выбрать все темы" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  it.each([["ru", "Темы", "Выбрать все темы"], ["uk", "Теми", "Обрати всі теми"], ["en", "Topics", "Select all topics"]] as const)(
    "uses the %s UI language while keeping German topic names", (language, heading, all) => {
      render(<TopicsPicker topics={topics} selected={[]} language={language} onChange={vi.fn()} />);
      expect(screen.getByRole("heading", { name: heading })).toBeDefined(); expect(screen.getByRole("button", { name: all })).toBeDefined();
      expect(screen.getByRole("checkbox", { name: "1. Über Größen" })).toBeDefined();
    });
});
