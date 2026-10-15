import { oneOf } from "../api/wireValidation";
import { ClosedAccessError, type OpenedAccess } from "../app/openedAccess";
import type { LearningApi } from "./learningApi";
import type { ManualContext } from "./manualSelectionController";

/** Satisfies the accepted ManualContext constructor. Never sent, stored or published: the adapter ignores it. */
export const ACCESS_BOUND_MARKER = "access-bound";

export function manualPairOf(access: OpenedAccess): ManualContext["pair"] {
  const pair = `${access.profile.dictionary_language}-de`;
  if (!oneOf(pair, ["ru-de", "uk-de", "en-de"])) throw new Error("unknown dictionary pair");
  return pair as ManualContext["pair"];
}

/** The opened Entry document the accepted controller was written for. Credentials stay in access.run. */
export function accessBoundManualContext(access: OpenedAccess): ManualContext {
  return { profileId: access.profile.profile_id, clientInstanceId: access.document.clientInstanceId,
    documentId: access.document.documentId, pair: manualPairOf(access),
    token: ACCESS_BOUND_MARKER, proof: ACCESS_BOUND_MARKER };
}

/**
 * Runs every Learning read and command inside one opened access handle.
 * isCurrent is the caller's binding: an obsolete call ends as ClosedAccessError
 * before access.run can treat its 401/403 as a denial of the current document.
 */
export function accessBoundLearningApi(options: { access: OpenedAccess; api: LearningApi; isCurrent(): boolean }): LearningApi {
  const { access, api } = options;
  const bound = <T>(operation: (credentials: { token: string; proof: string }) => Promise<T>): Promise<T> => {
    const requireCurrent = () => { if (!options.isCurrent()) throw new ClosedAccessError(); };
    return access.run(async credentials => {
      requireCurrent();
      try {
        const result = await operation(credentials);
        requireCurrent();
        return result;
      } catch (error) {
        requireCurrent();
        throw error;
      }
    });
  };
  return {
    get: () => bound(({ token }) => api.get(token)),
    change: (_token, _proof, command) => bound(({ token, proof }) => {
      // The controller fills these from its context and pending intent; another document's command is not sent.
      if (command.client_instance_id !== access.document.clientInstanceId || command.document_id !== access.document.documentId) {
        return Promise.reject(new Error("manual command belongs to another document"));
      }
      return api.change(token, proof, command);
    }),
    status: (_token, intent, ticket) => bound(({ token }) => api.status(token, intent, ticket)),
  };
}
