import type { OpenedClient, Profile } from "../api/generated";
import { ApiError } from "../api/http";

type Credentials = Readonly<{ token: string; proof: string; clientInstanceId: string; documentId: string }>;
export interface OpenedAccess {
  readonly key: string;
  readonly profile: Profile;
  readonly session: OpenedClient["session"];
  readonly document: Readonly<{ clientInstanceId: string; documentId: string; epoch: string }>;
  isLive(): boolean;
  run<T>(operation: (credentials: Credentials) => Promise<T>): Promise<T>;
}

export class ClosedAccessError extends Error {
  constructor() { super("closed_access"); }
}

/** Memory-only capability. Credentials are in the closure, never serialized metadata. */
export function createOpenedAccess(options: {
  opened: OpenedClient;
  token: string;
  proof: string;
  generation: number;
  isLive(): boolean;
  onDenied(error: ApiError): void;
}): OpenedAccess {
  const opened = structuredClone(options.opened);
  const credentials = Object.freeze({ token: options.token, proof: options.proof,
    clientInstanceId: opened.client_instance_id, documentId: opened.document_id });
  const requireLive = () => { if (!options.isLive()) throw new ClosedAccessError(); };
  return Object.freeze({
    key: `${opened.profile.profile_id}:${opened.document_id}:${opened.document_epoch}:${options.generation}`,
    get profile() { return structuredClone(opened.profile); },
    get session() { return structuredClone(opened.session); },
    document: Object.freeze({ clientInstanceId: opened.client_instance_id,
      documentId: opened.document_id, epoch: opened.document_epoch }),
    isLive: options.isLive,
    async run<T>(operation: (credentials: Credentials) => Promise<T>): Promise<T> {
      requireLive();
      try {
        const result = await operation(credentials);
        requireLive();
        return result;
      } catch (error) {
        requireLive(); // A late refusal from an old handle must not revoke a new one.
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) options.onDenied(error);
        throw error;
      }
    },
  });
}
