/**
 * Command-status replies recorded from the real core (HEAD with reapply_closed, f240ce5+), not hand-built.
 * Source: refusal_status_oral.json / refusal_status_conjugation.json, exchange "status_plain_unknown_closed"
 * (a lost command answer: not_found plus the closed-session boundary). Only the command id is rewritten by the
 * callers so it matches the command under test; the profile and boundary are verbatim.
 */
export const recordedOralUnknownClosed = {
  command: { id: "3bc653ba-59e8-40f7-af6b-e7e7f5f0dc9a", status: "not_found" },
  current: {
    profile_id: "6a52a744-9f29-4932-984c-06787d315ac8",
    access: { status: "admitted", version: "1", reason: null },
    reapply_closed: false,
    role: "user",
    ui_language: "ru",
    dictionary_language: "ru",
    time_zone: "UTC",
    state_version: "9",
  },
  state_version: "9",
  closed_session: { session_id: "07e60b7d-e975-4ee7-b1c0-6061d42b816b", status: "closed", close_reason: "stop" },
};

export const recordedConjugationUnknownClosed = {
  command: { id: "47008661-e916-4725-871d-fa89de3291f8", status: "not_found" },
  current: {
    profile_id: "49d4df9b-dde9-4731-95bb-81dda09d3aa7",
    access: { status: "admitted", version: "1", reason: null },
    reapply_closed: false,
    role: "user",
    ui_language: "ru",
    dictionary_language: "ru",
    time_zone: "UTC",
    state_version: "9",
  },
  state_version: "9",
  closed_session: { session_id: "01137542-1c21-46cf-b2f5-f46619c97055", status: "closed", close_reason: "stop" },
};
