import contract from "../api/generated.ts?raw";

/**
 * A runtime reading of src/api/generated.ts, which tools/generate_contract.py derives from core's OpenAPI.
 * Only the grammar that generator emits is understood: object literals with required/optional keys and an
 * index signature, unions, Array<…>, JSON literals, primitives and named references.
 */
type Shape =
  | { kind: "union"; options: Shape[] }
  | { kind: "object"; fields: Map<string, { shape: Shape; optional: boolean }>; index: Shape | null }
  | { kind: "array"; item: Shape }
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "primitive"; name: "string" | "number" | "boolean" | "null" | "unknown" }
  | { kind: "ref"; name: string };

const sources = new Map(Array.from(contract.matchAll(/^export type (\w+) = (.*);$/gm), match => [match[1], match[2]]));
const parsed = new Map<string, Shape>();

function parse(text: string): Shape {
  let at = 0;
  const space = () => { while (text[at] === " ") at++; };
  const take = (token: string) => {
    space();
    if (!text.startsWith(token, at)) throw new Error(`generated contract: expected ${token} at ${at} in ${text}`);
    at += token.length;
  };
  const peek = (token: string) => { space(); return text.startsWith(token, at); };
  const quoted = (): string => {
    space();
    const start = at++;
    while (text[at] !== "\"") at += text[at] === "\\" ? 2 : 1;
    return JSON.parse(text.slice(start, ++at)) as string;
  };
  function union(): Shape {
    const options = [primary()];
    while (peek("|")) { take("|"); options.push(primary()); }
    return options.length === 1 ? options[0] : { kind: "union", options };
  }
  function primary(): Shape {
    if (peek("(")) { take("("); const inner = union(); take(")"); return inner; }
    if (peek("Array<")) { take("Array<"); const item = union(); take(">"); return { kind: "array", item }; }
    if (peek("\"")) return { kind: "literal", value: quoted() };
    if (peek("{")) {
      take("{");
      const fields = new Map<string, { shape: Shape; optional: boolean }>();
      let index: Shape | null = null;
      while (!peek("}")) {
        if (peek("[key: string]:")) { take("[key: string]:"); index = union(); }
        else {
          const key = quoted(), optional = peek("?");
          if (optional) take("?");
          take(":"); fields.set(key, { shape: union(), optional });
        }
        take(";");
      }
      take("}");
      return { kind: "object", fields, index };
    }
    space();
    const word = /^-?[\w.]+/.exec(text.slice(at))?.[0];
    if (!word) throw new Error(`generated contract: unexpected ${text.slice(at, at + 20)}`);
    at += word.length;
    if (word === "true" || word === "false") return { kind: "literal", value: word === "true" };
    if (/^-?\d/.test(word)) return { kind: "literal", value: Number(word) };
    if (["string", "number", "boolean", "null", "unknown"].includes(word)) {
      return { kind: "primitive", name: word as "string" | "number" | "boolean" | "null" | "unknown" };
    }
    return { kind: "ref", name: word };
  }
  const shape = union(); space();
  if (at !== text.length) throw new Error(`generated contract: trailing ${text.slice(at)}`);
  return shape;
}

function named(name: string): Shape {
  const source = sources.get(name);
  if (source === undefined) throw new Error(`generated contract has no type ${name}`);
  if (!parsed.has(name)) parsed.set(name, parse(source));
  return parsed.get(name)!;
}

function conforms(value: unknown, shape: Shape): boolean {
  switch (shape.kind) {
    case "ref": return conforms(value, named(shape.name));
    case "union": return shape.options.some(option => conforms(value, option));
    case "literal": return value === shape.value;
    case "array": return Array.isArray(value) && value.every(item => conforms(item, shape.item));
    case "primitive": return shape.name === "unknown" || (shape.name === "null" ? value === null : typeof value === shape.name);
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
      const object = value as Record<string, unknown>;
      return [...shape.fields].every(([key, field]) => field.optional || Object.hasOwn(object, key))
        && Object.entries(object).every(([key, item]) => {
          const field = shape.fields.get(key);
          return field ? conforms(item, field.shape) : shape.index !== null && conforms(item, shape.index);
        });
    }
  }
}

/** True when the value has exactly the structure of the named generated contract type. */
export function conformsToGenerated(value: unknown, name: string): boolean {
  return conforms(value, named(name));
}
