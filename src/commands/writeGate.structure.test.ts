import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJsonTransport, type HttpOptions } from "../api/http";
import { createEntryApi } from "../api/entryApi";
import { createWrittenApi } from "../written/writtenApi";
import { POST_ROUTES, WriteGate } from "./writeGate";
import { ManualClock } from "./writeGate.test-support";

afterEach(() => { vi.unstubAllEnvs(); });

/** The production sources of the Mini App: everything under src except tests and test support. */
function productionSources(): { file: string; code: string }[] {
  const out: { file: string; code: string }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.|\.test-support\./.test(name)) {
        out.push({ file: relative("src", path), code: stripComments(readFileSync(path, "utf8")) });
      }
    }
  };
  walk("src");
  return out;
}

/** Comments out, strings and templates kept (a URL's // is no comment): enough for the structural rules below. */
function stripComments(source: string): string {
  let out = "", i = 0;
  const stack: string[] = [];
  while (i < source.length) {
    const c = source[i], next = source[i + 1];
    const quote = stack[stack.length - 1];
    if (quote === "'" || quote === "\"" || quote === "`") {
      out += c;
      if (c === "\\") { out += next ?? ""; i += 2; continue; }
      if (quote === "`" && c === "$" && next === "{") { out += next; stack.push("{"); i += 2; continue; }
      if (c === quote) stack.pop();
      i++;
      continue;
    }
    if (c === "/" && next === "/") { while (i < source.length && source[i] !== "\n") i++; continue; }
    if (c === "/" && next === "*") { const end = source.indexOf("*/", i + 2); i = end < 0 ? source.length : end + 2; continue; }
    if (c === "'" || c === "\"" || c === "`") stack.push(c);
    else if (c === "{" && stack.length) stack.push("{");
    else if (c === "}" && quote === "{") stack.pop();
    out += c;
    i++;
  }
  return out;
}

function count(code: string, pattern: RegExp): number { return [...code.matchAll(pattern)].length; }

describe("structure of the write path (RD-7 п.5, AC-42)", () => {
  const sources = productionSources();

  it("finds the production sources", () => {
    expect(sources.length).toBeGreaterThan(100);
    expect(sources.some(source => source.file === join("api", "http.ts"))).toBe(true);
  });

  it("(а) exactly one fetcher( call, inside the transport; no fetch, XMLHttpRequest, sendBeacon, WebSocket or EventSource", () => {
    const fetcherCalls = sources.flatMap(source => Array(count(source.code, /\bfetcher\s*\(/g)).fill(source.file));
    expect(fetcherCalls).toEqual([join("api", "http.ts")]);
    for (const pattern of [/\bfetch\s*\(/g, /\bXMLHttpRequest\b/g, /\bsendBeacon\b/g, /\bWebSocket\b/g, /\bEventSource\b/g]) {
      expect(sources.filter(source => count(source.code, pattern) > 0).map(source => source.file), String(pattern)).toEqual([]);
    }
  });

  it("(б) every production transport is built from the shared HttpOptions of its factory; the page's options carry the gate", () => {
    const calls = sources.flatMap(source => [...source.code.matchAll(/\bcreateJsonTransport\s*\(\s*([^)]*)\)/g)]
      .map(match => ({ file: source.file, argument: match[1].trim() })));
    expect(calls.length).toBeGreaterThanOrEqual(25);
    const bad = calls.filter(call => call.file !== join("api", "http.ts") && call.argument !== "options" && call.argument !== "own");
    expect(bad).toEqual([]);
    // `own` is the factory's options without the window's DOCUMENT_STALE hook: the gate stays in it.
    for (const call of calls.filter(entry => entry.argument === "own")) {
      const code = sources.find(source => source.file === call.file)!.code;
      expect(code, call.file).toMatch(/const \{ onDocumentStale: _window, \.\.\.own \} = (options|transport);/);
    }
    const app = sources.find(source => source.file === join("app", "App.tsx"))!.code;
    expect(app).toMatch(/const options: HttpOptions = \{[^}]*\bgate,/);
    expect(app).toMatch(/const gate = pageGate\.make\(\);/);
    const page = sources.find(source => source.file === join("app", "pageGate.ts"))!.code;
    expect(page).toMatch(/make\(\): WriteGate \{ return new WriteGate\(\); \}/);
    expect(page).toMatch(/createAvailabilityClient\(options\)\.probe/);
  });

  it("(б) gate is a required field of HttpOptions (RD-7 п.1)", () => {
    const http = sources.find(source => source.file === join("api", "http.ts"))!.code;
    expect(http).toMatch(/\n  gate: WriteGate;\n/);
    expect(http).not.toMatch(/gate\?: WriteGate/);
  });

  it("(б) outside tests a transport or an API factory without the gate is not built", () => {
    vi.stubEnv("MODE", "production");
    // A caller that bypasses the type (gate is required in HttpOptions): the construction itself refuses.
    const base = { fetcher: vi.fn() as unknown as typeof fetch, timeoutMs: 100, maxResponseBytes: 100 } as unknown as HttpOptions;
    expect(() => createJsonTransport(base)).toThrow(/gate/);
    expect(() => createEntryApi(base)).toThrow(/gate/);
    expect(() => createWrittenApi(base)).toThrow(/gate/);
    expect(() => createJsonTransport({ ...base, gate: new WriteGate({ clock: new ManualClock() }) })).not.toThrow();
  });

  it("(г) AC-54: every command status read in production code carries the ticket its caller got from gate.runReadback", () => {
    const reads = sources.flatMap(source => [...source.code.matchAll(/request\(`\/commands\/\$\{[\w.]+\}[^`]*`, \{([^}]*)\}\)/g)]
      .map(match => ({ file: source.file, options: match[1] })));
    expect(reads.length).toBeGreaterThanOrEqual(15);
    expect(reads.filter(read => !/readbackTicket: ticket/.test(read.options))).toEqual([]);
    // Every status path is built only in these reads.
    expect(sources.flatMap(source => Array(Math.max(0, count(source.code, /`\/commands\/\$\{/g) - count(source.code, /request\(`\/commands\/\$\{/g))).fill(source.file))).toEqual([]);
    expect(sources.filter(source => /["']\/commands\/["']/.test(source.code)).map(source => source.file)).toEqual([]);
  });
});

/**
 * The POST paths of core/docs/openapi.json at core a2c29f4 (P03 RD-8; without /api/v1): those of ceec5c9 and the notice
 * acknowledgement (N1). The live file of the sibling core checkout is compared too when it is there (the product layout
 * /…/wortly/{core,miniapp}).
 */
const CORE_POST_PATHS_A2C29F4 = ["/access/reapply", "/auth/telegram", "/client/events", "/client/open", "/client/register", "/commands",
  "/notices/{notice_id}/ack", "/profile/delete"];

function postPaths(openapi: { paths: Record<string, Record<string, unknown>> }): string[] {
  return Object.entries(openapi.paths)
    .filter(([, operations]) => Object.hasOwn(operations, "post"))
    .map(([path]) => path.replace(/^\/api\/v1/, ""))
    .sort();
}

describe("the registry of POST routes (RD-8, AC-43)", () => {
  it("classifies every POST of the core and nothing else", () => {
    expect(Object.keys(POST_ROUTES).sort()).toEqual([...CORE_POST_PATHS_A2C29F4].sort());
    for (const value of Object.values(POST_ROUTES)) expect(["exception", "foreground_only", "gated"]).toContain(value);
    expect(Object.entries(POST_ROUTES).filter(([, value]) => value !== "gated").map(([path]) => path).sort())
      .toEqual(["/auth/telegram", "/client/open", "/client/register"]);
  });

  const live = join("..", "core", "docs", "openapi.json");
  it.runIf(existsSync(live))("equals the POST paths of the sibling core's openapi.json", () => {
    expect(Object.keys(POST_ROUTES).sort()).toEqual(postPaths(JSON.parse(readFileSync(live, "utf8"))));
  });
});
