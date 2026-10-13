/**
 * The owner's list of common translations of one language (R14-01): every translation is its own field, the order is
 * the display order the server stores (core catalog_writer._save_translations: position = list order). Pure functions:
 * the editor, the drag gesture and the keyboard buttons all change the order only through them.
 */

/** One field of the list; `key` is stable while the field lives, so a moved field keeps its focus and its text. */
export type TranslationItem = { key: string; text: string };

export function itemsOf(texts: readonly string[], newKey: () => string): TranslationItem[] {
  return texts.map(text => ({ key: newKey(), text }));
}

/** What a save sends: every field in its order, as typed (the core trims the edges, C-FIELDS-3). */
export function textsOf(items: readonly TranslationItem[]): string[] {
  return items.map(item => item.text);
}

/** The new order with the field at `from` placed at `to`; an index outside the list changes nothing. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const list = [...items];
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= list.length || to >= list.length
    || from === to) return list;
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
  return list;
}

/** «Выше»: one place up; the first field stays first. */
export function moveUp<T>(items: readonly T[], index: number): T[] {
  return moveItem(items, index, index - 1);
}

/** «Ниже»: one place down; the last field stays last. */
export function moveDown<T>(items: readonly T[], index: number): T[] {
  return moveItem(items, index, index + 1);
}

/** R12-06: the last common translation of a language cannot be removed. */
export function canRemove(items: readonly unknown[]): boolean {
  return items.length > 1;
}

/** «Крестик»: removes one field; the last one is refused (the list comes back unchanged). */
export function removeItem<T>(items: readonly T[], index: number): T[] {
  if (!canRemove(items) || !Number.isInteger(index) || index < 0 || index >= items.length) return [...items];
  return items.filter((_, position) => position !== index);
}

/** «+»: a new empty field at the end. */
export function addItem(items: readonly TranslationItem[], key: string): TranslationItem[] {
  return [...items, { key, text: "" }];
}

/** A blank field is not a translation: the core refuses it (common_fields._text); the editor asks to fill or remove it. */
export function hasBlank(items: readonly TranslationItem[]): boolean {
  return items.some(item => item.text.trim() === "");
}

export function sameTexts(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((text, index) => text === right[index]);
}

/**
 * Where a dragged field lands. `heights` are the measured heights of the fields in their current order, `gap` the space
 * between two fields, `offset` how far the pointer moved the dragged field from its place (down is positive). The field
 * takes the place of a neighbour once its middle passes that neighbour's middle; it can become the first or the last.
 */
export function dropIndex(from: number, offset: number, heights: readonly number[], gap: number): number {
  if (from < 0 || from >= heights.length || !Number.isFinite(offset)) return from;
  let index = from, travelled = 0;
  if (offset > 0) {
    while (index + 1 < heights.length) {
      const step = heights[index + 1] + gap;
      // The neighbour's middle: half of its height plus the gap before it.
      if (offset - travelled < heights[index + 1] / 2 + gap) break;
      travelled += step; index++;
    }
  } else if (offset < 0) {
    while (index - 1 >= 0) {
      const step = heights[index - 1] + gap;
      if (-offset - travelled < heights[index - 1] / 2 + gap) break;
      travelled += step; index--;
    }
  }
  return index;
}

/**
 * How far another field moves aside while one is dragged from `from` to `to` (R14-01: the fields part smoothly): the
 * fields between give up their places by the height of the dragged field plus the gap. The dragged field itself follows
 * the pointer and is not shifted here.
 */
export function shiftOf(index: number, from: number, to: number, draggedHeight: number, gap: number): number {
  if (index === from) return 0;
  const distance = draggedHeight + gap;
  if (from < to && index > from && index <= to) return -distance;
  if (from > to && index < from && index >= to) return distance;
  return 0;
}
