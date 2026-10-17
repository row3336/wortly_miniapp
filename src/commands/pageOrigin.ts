import type { AsyncStorage } from "../platform/storage";

/**
 * The command IDs whose intent this page created (decision 2.3 А, owner 09.10.2026, C109). The durable record names
 * no document, so a record that another window or a reload left behind is told apart only here: a page keeps the IDs
 * it created in its memory, shared by its document owners through the storage they share (the key of the page's send
 * budget store, intentBudget.ts pageBudgetSource). A record not created here is checked and its confirmed outcome shown,
 * but its manual retry is never offered or sent. Nothing is stored: no new field, no new record format.
 */
const created = new WeakMap<AsyncStorage, Set<string>>();

export function noteCreatedHere(storage: AsyncStorage, commandId: string): void {
  let ids = created.get(storage);
  if (!ids) { ids = new Set(); created.set(storage, ids); }
  ids.add(commandId.toLowerCase());
}

export function createdHere(storage: AsyncStorage, commandId: string | null | undefined): boolean {
  return typeof commandId === "string" && (created.get(storage)?.has(commandId.toLowerCase()) ?? false);
}
