import { useCallback, useEffect, useReducer, useRef } from "react";
import type { HttpOptions } from "../api/http";
import { oneOf, version } from "../api/wireValidation";
import { ClosedAccessError, type OpenedAccess } from "../app/openedAccess";
import type { PracticeWeek } from "./practiceApi";
import { createStatisticsApi } from "./statisticsApi";
import { StatisticsController, type StatisticsSnapshot, type StatisticsSource } from "./statisticsController";

export type StatisticsDocumentOptions = {
  access: OpenedAccess;
  transport: HttpOptions;
  week: PracticeWeek;
  enabled: boolean;
  minimumStateVersion?: string;
};
type Identity = { key: string; transport: HttpOptions };
type Retained = { identity: Identity; floor: string };
type Owner = { access: OpenedAccess; identity: Identity; week: PracticeWeek; controller: StatisticsController; source: StatisticsSource };
function identity({ access, transport }: StatisticsDocumentOptions): Identity {
  return { key: JSON.stringify([access.key, access.profile.profile_id, access.document.clientInstanceId,
    access.document.documentId, access.document.epoch, access.profile.dictionary_language]), transport };
}
function same(left: Identity, right: Identity): boolean {
  return left.key === right.key && left.transport === right.transport;
}

/** Bind read callbacks to one access handle. The caller owns the explicit period and route. */
export function useStatisticsDocument(options: StatisticsDocumentOptions): { state: StatisticsSnapshot; refresh(): Promise<void> } {
  if (!oneOf(options.week, ["current", "previous"])) throw new Error("explicit statistics week required");
  const latest = useRef(options); latest.current = options;
  const owner = useRef<Owner | null>(null), retained = useRef<Retained | null>(null);
  const suspended = useRef(new WeakSet<OpenedAccess>());
  const [, repaint] = useReducer((value: number) => value + 1, 0);
  const id = identity(options);
  // Retain observations in render, including disabled renders and a disappearing publisher.
  if (!retained.current || !same(retained.current.identity, id)) {
    retained.current = { identity: id, floor: options.access.profile.state_version };
  }
  for (const observed of [options.access.profile.state_version, options.minimumStateVersion]) {
    if (observed === undefined) continue;
    if (!version(observed)) throw new Error("invalid statistics state version");
    if (BigInt(observed) > BigInt(retained.current.floor)) retained.current.floor = observed;
  }
  const lookup = () => {
    const current = latest.current, bound = owner.current;
    return bound && current.enabled && current.access.isLive() && current.access.profile.access.status === "admitted"
      && current.access === bound.access && current.week === bound.week && same(identity(current), bound.identity)
      && !suspended.current.has(current.access) && document.visibilityState === "visible" ? bound : null;
  };
  const find = useRef(lookup); find.current = lookup;
  useEffect(() => {
    const suspend = () => { suspended.current.add(latest.current.access); repaint(); };
    document.addEventListener("visibilitychange", suspend, true);
    window.addEventListener("pageshow", suspend, true);
    return () => {
      document.removeEventListener("visibilitychange", suspend, true);
      window.removeEventListener("pageshow", suspend, true);
    };
  }, []);
  useEffect(() => {
    const current = latest.current, access = current.access;
    if (document.visibilityState !== "visible") suspended.current.add(access);
    if (!current.enabled || !access.isLive() || access.profile.access.status !== "admitted" || suspended.current.has(access)) return;
    const saved = retained.current!, api = createStatisticsApi(current.transport);
    const pair = `${access.profile.dictionary_language}-de` as NonNullable<StatisticsSnapshot["pair"]>;
    let active = true, readGeneration = 0;
    const live = () => active && find.current() === bound;
    const controller = new StatisticsController({ isLive: live, minimumStateVersion: () => saved.floor,
      onUpdate(snapshot) {
        if (!live()) return;
        if (snapshot.data && BigInt(snapshot.data.state_version) > BigInt(saved.floor)) saved.floor = snapshot.data.state_version;
        repaint();
      } });
    const source: StatisticsSource = { identity: access, get(week) {
      const generation = ++readGeneration;
      const requireCurrent = () => {
        if (!live() || generation !== readGeneration) throw new ClosedAccessError();
      };
      return access.run(async ({ token }) => {
        requireCurrent();
        try {
          const data = await api.get(token, week);
          requireCurrent();
          return data;
        } catch (error) {
          // Obsolete denials must be discarded before access.run can revoke this handle.
          requireCurrent();
          throw error;
        }
      });
    } };
    const bound: Owner = { access, identity: id, week: current.week, controller, source };
    owner.current = bound;
    void controller.load(source, pair, current.week);
    return () => { active = false; controller.dispose(); if (owner.current === bound) owner.current = null; };
  }, [options.access, options.transport, options.week, options.enabled, options.minimumStateVersion]);
  const refresh = useCallback(() => {
    const bound = find.current();
    return bound ? bound.controller.load(bound.source,
      `${bound.access.profile.dictionary_language}-de` as NonNullable<StatisticsSnapshot["pair"]>, bound.week) : Promise.resolve();
  }, []);
  const bound = lookup();
  const state: StatisticsSnapshot = bound ? bound.controller.snapshot() : {
    phase: !options.enabled ? "idle" : !options.access.isLive() || options.access.profile.access.status !== "admitted" ? "disposed" : "loading",
    pair: null, week: options.week, data: null, problem: null,
  };
  return { state, refresh };
}
