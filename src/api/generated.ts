// Generated from core FastAPI OpenAPI. Do not edit by hand.

export type Access = { "status": "admitted" | "pending" | "rejected"; "version": string; "reason": (string | null); };

export type AccessCommandResponse = { "command": CommandFact; "current": Profile; };

export type ActionUndoCommand = { "command_id": string; "kind": "action.undo"; "client_instance_id": string; "document_id": string; "context_id": string; "action_id": string; "expected_action_version": string; "payload": EmptyPayload; };

export type AnswerSubmitCommand = { "command_id": string; "client_instance_id": string; "document_id": string; "session_id": string; "kind": "answer.submit"; "assignment_id": string; "payload": (TextAnswerPayload | ForgotAnswerPayload); };

export type AuthRequest = { "client_version": string; "contract_version": string; "init_data": string; "saved_language"?: ("uk" | "en" | "ru" | null); "browser_language"?: (string | null); };

export type AuthResponse = { "access_token": string; "expires_at": string; "profile": Profile; "compatibility": Compatibility; };

export type BaseCounts = { "total": number; "words": number; "phrases": number; };

export type BusyClient = { "status": "SESSION_BUSY"; "profile": Profile; "session": BusySession; "compatibility": Compatibility; };

export type BusySession = { "status": "busy"; "stop_remote_target"?: (string | null); "document_conflict"?: boolean; "document_epoch"?: (string | null); };

export type CardContextCloseCommand = { "command_id": string; "kind": "context.close"; "client_instance_id": string; "document_id": string; "context_id": string; "payload": EmptyPayload; };

export type CardContextOpenCommand = { "command_id": string; "kind": "context.open"; "client_instance_id": string; "document_id": string; "payload": CardContextOpenPayload; };

export type CardContextOpenPayload = { "card_id": string; "source": DictionaryContextSource; };

export type CardExample = { "id": string; "text": string; "role": ("general" | "wechsel_location" | "wechsel_direction" | null); "highlighted_parts": Array<JsonValue>; };

export type CardExamples = { "common": Array<CardExample>; "personal": (PersonalCardText | null); };

export type CardTranslations = { "common": Array<string>; "personal": (PersonalCardText | null); };

export type ClosedDictionaryContext = { "status": "closed"; "context": DictionaryContextReference; };

export type ClosedSessionBoundary = { "session_id": string; "status": "closed"; "close_reason": "midnight" | "pair_changed" | "timezone_date_changed" | "stop" | "remote_stop" | "summary_home"; };

export type CommandFact = { "id": string; "status": "applied" | "already_applied"; "applied_at": string; "target_id": (string | null); "object_version": string; };

export type CommandStatusResponse = { "command": (StoredCommandFact | MissingCommandFact); "current": (Profile | ModeState | UnavailableCurrent | SettingsProjection | SessionProjection | LearningSessionProjection | OralSessionProjection | ConjugationSessionProjection | UnavailableSession | RemoteSessionProjection | LearningCurrentProjection | ConjugationCatalog); "state_version": string; "closed_session"?: (ClosedSessionBoundary | null); "verified_intent_hash"?: (string | null); };

export type Compatibility = { "compatible": boolean; "contract_version": string; };

export type CompleteAnswerVariant = { "parts": Array<string>; };

export type ConjugationAnswerResponse = { "action": (WrittenAction | null); "result": (WrittenResult | null); "step": (ConjugationSessionProjection | UnavailableSession | UnavailableCurrent); "capabilities": LearningAnswerCapabilities; "command": (SavedCommandFact | RejectedCommandFact); "state_version": string; "error"?: (ErrorDetail | null); };

export type ConjugationAnswerSpec = { "kind": "forms"; "labels": Array<string>; "part_count": 1; "case_sensitive": boolean; };

export type ConjugationAnswerStatusResponse = { "action": (WrittenAction | null); "result": (WrittenResult | null); "step": (ConjugationSessionProjection | UnavailableSession | UnavailableCurrent); "capabilities": LearningAnswerCapabilities; "command": StoredCommandFact; "state_version": string; "verified_intent_hash"?: (string | null); };

export type ConjugationAssignment = { "id": string; "card_id": string; "status": "prefetched" | "presented"; "kind": "conjugation"; "cycle_id": string; "slot_id": ConjugationSlot; "base_verb_id": string; "display_verb_id": string; "tense": "present" | "preterite"; "pronoun_group": "ich" | "du" | "er_sie_es" | "wir" | "ihr" | "sie_sie"; "prompt": ConjugationPrompt; "answer_spec": ConjugationAnswerSpec; };

export type ConjugationCatalog = { "pair": "ru-de" | "uk-de" | "en-de"; "local_date": string; "items": Array<ConjugationCatalogItem>; };

export type ConjugationCatalogItem = { "base_verb_id": string; "lemma": string; "tense": "present" | "preterite"; "status": "openable" | "scheduled" | "ready" | "completed"; "due_date": (string | null); "can_schedule": boolean; };

export type ConjugationCatalogResponse = { "current": ConjugationCatalog; "state_version": string; };

export type ConjugationCounts = { "ready": number; "openable": number; "next_due_date": (string | null); };

export type ConjugationPartialBlock = { "cycle_id": string; "answered_groups": Array<"ich" | "du" | "er_sie_es" | "wir" | "ihr" | "sie_sie">; };

export type ConjugationPrompt = { "verb": string; "translation": string; "language": "ru" | "uk" | "en"; "pronoun": string; "tense": "present" | "preterite"; };

export type ConjugationResultReadResponse = { "action": (WrittenAction | null); "result": (WrittenResult | null); "step": (ConjugationSessionProjection | UnavailableSession | UnavailableCurrent); "capabilities": LearningAnswerCapabilities; "state_version": string; };

export type ConjugationScheduleCommand = { "command_id": string; "kind": "conjugation.schedule"; "client_instance_id": string; "document_id": string; "payload": ConjugationSchedulePayload; };

export type ConjugationSchedulePayload = { "base_verb_id": string; "tense": "present" | "preterite"; };

export type ConjugationScheduleResponse = { "command": (SavedCommandFact | RejectedCommandFact); "current": ConjugationCatalog; "state_version": string; "error"?: (ErrorDetail | null); };

export type ConjugationSessionCapabilities = { "answer_target": (string | null); "correct_target": null; "grades": null; "undo_target": null; "stop": boolean; "summary_home": boolean; };

export type ConjugationSessionProjection = { "session_id": string; "status": "active" | "summary" | "closed"; "mode": "conjugation"; "pair": "ru-de" | "uk-de" | "en-de"; "direction": "conjugation"; "local_date": string; "close_reason": ("midnight" | "pair_changed" | "timezone_date_changed" | "stop" | "remote_stop" | "summary_home" | null); "progress": WrittenProgress; "assignment": (ConjugationAssignment | null); "summary": (ConjugationSummary | null); "capabilities": ConjugationSessionCapabilities; };

export type ConjugationSlot = { "cycle_id": string; "pronoun_group": "ich" | "du" | "er_sie_es" | "wir" | "ihr" | "sie_sie"; };

export type ConjugationStartPayload = { "mode": "conjugation"; };

export type ConjugationSummary = { "completed_cycle_ids": Array<string>; "partial": Array<ConjugationPartialBlock>; "results": Array<ConjugationSummaryResult>; "completed": number; "correct": number; "wrong": number; "blocks": (Array<ConjugationSummaryBlock> | null); };

export type ConjugationSummaryBlock = { "cycle_id": string; "base_verb_id": string; "base_lemma": string; "tense": "present" | "preterite"; "answered_groups": Array<"ich" | "du" | "er_sie_es" | "wir" | "ihr" | "sie_sie">; "effect": "incomplete" | "error" | "success"; "grade": (2 | 3 | 4 | 5 | null); };

export type ConjugationSummaryResult = { "result_id": string; "version": string; };

export type ConjunctionHint = { "meaning_category": (string | null); "verb_position": (string | null); };

export type CurrentReviewProgress = { "interval_days": number; "repetitions": number; "ease": string; "due_date": string; "version": string; };

export type DecideCommand = { "command_id": string; "kind": "access.decide"; "payload": DecidePayload; };

export type DecidePayload = { "request_id": string; "expected_version": string; "approve": boolean; "reason"?: (string | null); };

export type DictionaryCardContent = { "pair": "ru-de" | "uk-de" | "en-de"; "card": DictionaryReferenceCard; "translations": CardTranslations; "grammar": (ReferenceNoun | ReferenceVerb | ReferenceAdjective | ReferencePreposition | ReferenceConjunction | null); "reference_conjugations": Array<ReferenceConjugation>; "examples": CardExamples; "association": (PersonalCardText | null); "hint": (PersonalCardText | null); };

export type DictionaryCardResponse = { "state_version": string; "current": (DictionaryCardContent | UnavailableCurrent); };

export type DictionaryCardStudy = { "status": "available"; "card_id": string; "card_revision": string; "pair": "ru-de" | "uk-de" | "en-de"; "card_type": "noun" | "verb" | "phrase" | "adjective" | "pronoun" | "adverb" | "preposition" | "conjunction" | "particle"; "local_date": (string | null); "facts": DictionaryStudyFacts; "directions": Array<DictionaryStudyDirection>; };

export type DictionaryCardView = { "status": "available"; "content": DictionaryCardContent; "study": DictionaryCardStudy; };

export type DictionaryCardViewResponse = { "state_version": string; "current": (DictionaryCardView | UnavailableCurrent); };

export type DictionaryContextCapabilities = { "interval_increase": (DictionaryIntervalCapability | null); "undo_target": (DictionaryUndoTarget | null); };

export type DictionaryContextCommandResponse = { "command": (SavedCommandFact | RejectedCommandFact); "current": (OpenDictionaryContext | ClosedDictionaryContext | UnavailableCurrent); "state_version": string; "error"?: (ErrorDetail | null); };

export type DictionaryContextInterval = { "local_date": string; "expected_pair": "ru-de" | "uk-de" | "en-de"; "directions": Array<DictionaryIntervalDirection>; };

export type DictionaryContextReference = { "id": string; "kind": "dictionary"; "card_id": string; };

export type DictionaryContextResponse = { "current": (OpenDictionaryContext | ClosedDictionaryContext | UnavailableCurrent); "state_version": string; };

export type DictionaryContextSource = { "kind": "dictionary"; };

export type DictionaryContextStatusResponse = { "command": StoredCommandFact; "current": (OpenDictionaryContext | ClosedDictionaryContext | UnavailableCurrent); "state_version": string; "verified_intent_hash"?: (string | null); };

export type DictionaryExclusion = { "excluded": boolean; "version": (string | null); };

export type DictionaryIntervalCapability = { "directions": Array<"l1-de" | "de-l1">; };

export type DictionaryIntervalChoice = { "option_id": number; "interval_days": number; "next_due_date": string; };

export type DictionaryIntervalDirection = { "direction": "l1-de" | "de-l1"; "applicable": boolean; "current_schedule": (DictionaryIntervalSchedule | null); "expected_progress_version": (string | null); "options": Array<DictionaryIntervalChoice>; };

export type DictionaryIntervalOption = { "step_id": number; "interval_days": number; "next_due_date": string; };

export type DictionaryIntervalSchedule = { "interval_days": number; "next_due_date": string; "persisted": boolean; };

export type DictionaryLearningFacts = { "ever_selected": boolean; "finished_or_skipped": boolean; "current": (DictionaryLearningMember | null); };

export type DictionaryLearningMember = { "group_id": string; "group_status": "assembling" | "active"; "member_status": "pending" | "active"; "member_version": string; };

export type DictionaryManualSelection = { "selected": boolean; "selection_version": string; };

export type DictionaryReferenceCard = { "id": string; "revision": string; "lemma": string; "type": "noun" | "verb" | "phrase" | "adjective" | "pronoun" | "adverb" | "preposition" | "conjunction" | "particle"; "cefr": ("A1" | "A2" | "B1" | "B2" | "C1" | "C2" | null); };

export type DictionaryReviewSchedule = { "interval_days": number; "next_due_date": string; };

export type DictionarySearchItem = { "card_id": string; "revision": string; "lemma": string; "type": "noun" | "verb" | "phrase" | "adjective" | "pronoun" | "adverb" | "preposition" | "conjunction" | "particle"; "cefr": ("A1" | "A2" | "B1" | "B2" | "C1" | "C2" | null); "translation": CardTranslations; "match_kind": "exact" | "prefix" | "substring"; };

export type DictionarySearchResponse = { "state_version": string; "query": string; "pair": "ru-de" | "uk-de" | "en-de"; "mode": "words" | "phrases"; "items": Array<DictionarySearchItem>; "next_cursor": (string | null); "similar": (Array<DictionarySimilarItem> | null); };

export type DictionarySimilarItem = { "card_id": string; "revision": string; "lemma": string; "type": "noun" | "verb" | "phrase" | "adjective" | "pronoun" | "adverb" | "preposition" | "conjunction" | "particle"; "cefr": ("A1" | "A2" | "B1" | "B2" | "C1" | "C2" | null); "translation": CardTranslations; };

export type DictionaryStudyDirection = { "direction": "l1-de" | "de-l1"; "introduced": boolean; "progress_present": boolean; "progress_version": (string | null); "schedule": (DictionaryReviewSchedule | null); "interval_preview": (Array<DictionaryIntervalOption> | null); };

export type DictionaryStudyFacts = { "common_translation_present": boolean; "exclusion": DictionaryExclusion; "manual": DictionaryManualSelection; "learning": DictionaryLearningFacts; "non_learning_history": boolean; };

export type DictionaryUndoTarget = { "action_id": string; "kind": "interval.increase"; "version": string; "context_id": string; };

export type DirectionCounts = { "l1-de": ReadyCount; "de-l1": ReadyCount; };

export type EmptyPayload = {  };

export type ErrorDetail = { "code": string; };

export type ErrorResponse = { "error": ErrorDetail; };

export type ExpectedProgressVersion = { "direction": "l1-de" | "de-l1"; "version": (string | null); };

export type ForgotAnswerPayload = { "forgot": true; };

export type GrammarTerm = { "id": string; "name": string; };

export type InitialAnswerCheck = { "correct": boolean; "variant_index": (number | null); "correct_answer": string; "other_answers": Array<string>; "matched_spans": Array<MatchedSpan>; "input_errors"?: (Array<MatchedSpan> | null); "answer_errors"?: (Array<MatchedSpan> | null); "span_unit": "unicode_code_point"; "span_bounds": "start_inclusive_end_exclusive"; };

export type IntervalIncreaseCommand = { "command_id": string; "kind": "interval.increase"; "client_instance_id": string; "document_id": string; "context_id": string; "expected_progress_versions": Array<ExpectedProgressVersion>; "payload": IntervalIncreasePayload; };

export type IntervalIncreasePayload = { "card_id": string; "expected_pair": "ru-de" | "uk-de" | "en-de"; "expected_local_date": string; "selections": Array<IntervalSelection>; };

export type IntervalSelection = { "direction": "l1-de" | "de-l1"; "option_id": number; "interval_days": number; "next_due_date": string; };

export type JsonValue = unknown;

export type LearningAnswerCapabilities = { "answer_target": (string | null); "grades": (LearningGradeCapability | null); "correct_target": (LearningResultTarget | null); "undo_target": null; "stop": boolean; "summary_home": boolean; };

export type LearningAnswerResponse = { "action": (WrittenAction | null); "result": (WrittenResult | null); "step": (LearningSessionProjection | UnavailableSession | UnavailableCurrent); "capabilities": LearningAnswerCapabilities; "command": (SavedCommandFact | RejectedCommandFact); "state_version": string; "error"?: (ErrorDetail | null); };

export type LearningAnswerStatusResponse = { "action": (WrittenAction | null); "result": (WrittenResult | null); "step": (LearningSessionProjection | UnavailableSession | UnavailableCurrent); "capabilities": LearningAnswerCapabilities; "command": StoredCommandFact; "state_version": string; "verified_intent_hash"?: (string | null); };

export type LearningCommandResponse = { "command": (SavedCommandFact | RejectedCommandFact); "current": LearningCurrentProjection; "state_version": string; "error"?: (ErrorDetail | null); };

export type LearningCounts = { "status": "preview" | "ready" | "waiting" | "completed" | "setup_required" | "new_group" | "no_material"; "ready": number; "preview": number; "next_due_at": (string | null); "new_group_size": number; "manual_eligible": number; "automatic_eligible": number; };

export type LearningCurrentProjection = { "pair": "ru-de" | "uk-de" | "en-de"; "learning": LearningCounts; "group": (LearningGroup | null); "manual_selection": Array<ManualLearningSelection>; "manual_selection_version": string; };

export type LearningCurrentResponse = { "pair": "ru-de" | "uk-de" | "en-de"; "learning": LearningCounts; "group": (LearningGroup | null); "manual_selection": Array<ManualLearningSelection>; "manual_selection_version": string; "state_version": string; };

export type LearningGradeCapability = { "session_id": string; "assignment_id": string; "result_id": string; "expected_result_version": string; "values": Array<3 | 4 | 5>; };

export type LearningGroup = { "group_id": string; "status": "assembling" | "active"; "created_at": string; "members": Array<LearningMember>; "introduction": (LearningIntroduction | null); };

export type LearningIntroduction = { "position": number; "version": string; "next_card_id": (string | null); };

export type LearningMember = { "card_id": string; "introduction_order": number; "stage": number; "due_at": (string | null); "recovery_remaining": number; "status": "pending" | "active" | "completed" | "skipped"; "version": string; "available": boolean; "needs_preview": boolean; "ready": boolean; };

export type LearningPreviewAddress = { "id": string; "card_id": string; "position": number; "total": number; "content": LearningPreviewContent; };

export type LearningPreviewCommand = { "command_id": string; "client_instance_id": string; "document_id": string; "session_id": string; "kind": "learning.preview_next" | "learning.known"; "preview_id": string; "payload": EmptyPayload; };

export type LearningPreviewContent = { "pair": "ru-de" | "uk-de" | "en-de"; "card": ReferenceCard; "translations": CardTranslations; "grammar": (ReferenceNoun | ReferenceVerb | ReferenceAdjective | ReferencePreposition | ReferenceConjunction | null); "reference_conjugations": Array<ReferenceConjugation>; "examples": CardExamples; "association": (PersonalCardText | null); "hint": (PersonalCardText | null); };

export type LearningResultReadResponse = { "action": (WrittenAction | null); "result": (WrittenResult | null); "step": (LearningSessionProjection | UnavailableSession | UnavailableCurrent); "capabilities": LearningAnswerCapabilities; "state_version": string; };

export type LearningResultTarget = { "session_id": string; "assignment_id": string; "result_id": string; "expected_result_version": string; };

export type LearningSessionGroup = { "id": string; "status": "assembling" | "active" | "completed"; "version": string; "preview_position": number; "total": number; };

export type LearningSessionProjection = { "session_id": string; "status": "active" | "summary" | "closed"; "mode": "learning"; "pair": "ru-de" | "uk-de" | "en-de"; "local_date": string; "close_reason": ("midnight" | "pair_changed" | "timezone_date_changed" | "stop" | "remote_stop" | "summary_home" | null); "group": LearningSessionGroup; "preview": (LearningPreviewAddress | null); "assignment": (PublicAssignment | null); };

export type LearningStartPayload = { "mode": "learning"; };

export type LevelMaterial = { "mode": "level"; "selected_level": "A1" | "A2" | "B1" | "B2" | "C1" | "C2"; };

export type ManualLearningSelection = { "card_id": string; "position": number; "version": string; "eligible": boolean; };

export type ManualSelectionCommand = { "command_id": string; "kind": "learning.select" | "learning.unselect"; "client_instance_id": string; "document_id": string; "expected_selection_version": string; "payload": ManualSelectionPayload; };

export type ManualSelectionPayload = { "card_id": string; "expected_pair": "ru-de" | "uk-de" | "en-de"; };

export type MatchedSpan = { "start": number; "end": number; };

export type MissingCommandFact = { "id": string; "status": "not_found"; };

export type ModeCommand = { "command_id": string; "kind": "access.mode"; "payload": ModePayload; };

export type ModeCommandResponse = { "command": CommandFact; "current": ModeState; };

export type ModePayload = { "mode": "manual" | "automatic"; "expected_version": string; };

export type ModeState = { "mode": "manual" | "automatic"; "version": string; };

export type OpenDictionaryContext = { "status": "open"; "context": DictionaryContextReference; "view": (DictionaryCardView | UnavailableCurrent); "interval": (DictionaryContextInterval | null); "capabilities": DictionaryContextCapabilities; };

export type OpenRequest = { "client_version": string; "contract_version": string; "client_instance_id": string; "document_id": string; "time_zone": string; "event": "open" | "foreground"; "holds_document_lock"?: boolean; "confirm_document_replacement"?: boolean; "expected_document_epoch"?: (string | null); };

export type OpenedClient = { "status": "opened"; "client_instance_id": string; "document_id": string; "document_epoch": string; "proof_version": string; "profile": Profile; "session": (SessionReference | null); "compatibility": Compatibility; };

export type OralAssignment = { "id": string; "card_id": string; "status": "prefetched" | "presented"; "kind": "original" | "drill"; "prompt": OralPrompt; "revealed": false; };

export type OralCapabilities = { "reveal_target": (string | null); "grade_target": (string | null); "stop": boolean; "summary_home": boolean; };

export type OralGradeCommand = { "command_id": string; "client_instance_id": string; "document_id": string; "session_id": string; "kind": "oral.grade"; "assignment_id": string; "payload": OralGradePayload; };

export type OralGradePayload = { "correct": boolean; };

export type OralPractice = { "pair": "ru-de" | "uk-de" | "en-de"; "direction": "de-l1"; "local_date": string; "time_zone": string; "count": number; };

export type OralPrompt = { "text": string; "language": "de"; "conjunction_hint": (ConjunctionHint | null); };

export type OralRevealCommand = { "command_id": string; "client_instance_id": string; "document_id": string; "session_id": string; "kind": "oral.reveal"; "assignment_id": string; "payload": EmptyPayload; };

export type OralSessionProjection = { "session_id": string; "status": "active" | "summary" | "closed"; "mode": "oral"; "pair": "ru-de" | "uk-de" | "en-de"; "direction": "de-l1"; "local_date": string; "bucket": ("words" | "phrases" | null); "close_reason": ("midnight" | "pair_changed" | "timezone_date_changed" | "stop" | "remote_stop" | "summary_home" | null); "progress": WrittenProgress; "assignment": (OralAssignment | RevealedOralAssignment | null); "summary": (WrittenSummary | null); "practice": OralPractice; "capabilities": OralCapabilities; };

export type OralStartPayload = { "mode": "oral"; "bucket": "words" | "phrases"; };

export type OrdinaryCounts = { "words": DirectionCounts; "phrases": DirectionCounts; };

export type PersonalCardText = { "value": string; "version": string; };

export type PracticeDay = { "local_date": string; "directions": PracticeDirections; };

export type PracticeDirections = { "l1-de": number; "de-l1": number; };

export type PracticeResponse = { "state_version": string; "local_date": string; "pair": "ru-de" | "uk-de" | "en-de"; "time_zone": string; "starts_at": string; "ends_at": string; "days": Array<PracticeDay>; };

export type PresentCommand = { "command_id": string; "client_instance_id": string; "document_id": string; "session_id": string; "kind": "assignment.present"; "assignment_id": string; "payload": EmptyPayload; };

export type Profile = { "profile_id": string; "access": Access; "role": "owner" | "user"; "ui_language": "uk" | "en" | "ru"; "dictionary_language": "uk" | "en" | "ru"; "time_zone": (string | null); "state_version": string; };

export type PublicAnswerSpec = { "kind": "word" | "forms" | "phrase"; "labels": Array<string>; "part_count": number; "case_sensitive": boolean; };

export type PublicAssignment = { "id": string; "card_id": string; "status": "prefetched" | "presented"; "kind": "original" | "drill" | "learning" | "conjugation"; "prompt": QuestionPrompt; "answer_spec": PublicAnswerSpec; };

export type QuestionPrompt = { "text": string; "language": "uk" | "en" | "ru"; "translations": Array<string>; "personal_translation_version": (string | null); "hint": (string | null); "hint_version": (string | null); "conjunction_hint": (ConjunctionHint | null); };

export type ReadyCount = { "ready": number; "next_due_date": (string | null); };

export type ReapplyRequest = { "command_id": string; "expected_access_version": string; };

export type ReferenceAdjective = { "positive": (string | null); "positive_status": "applicable" | "not_applicable" | "unknown"; "comparative": (string | null); "comparative_status": "applicable" | "not_applicable" | "unknown"; "superlative": (string | null); "superlative_status": "applicable" | "not_applicable" | "unknown"; };

export type ReferenceCard = { "id": string; "revision": string; "lemma": string; "type": "noun" | "verb" | "adjective" | "pronoun" | "adverb" | "preposition" | "conjunction" | "particle"; "cefr": ("A1" | "A2" | "B1" | "B2" | "C1" | "C2" | null); };

export type ReferenceConjugation = { "tense": "present" | "preterite"; "forms": Array<ReferenceConjugationForm>; };

export type ReferenceConjugationForm = { "pronoun_group": "ich" | "du" | "er_sie_es" | "wir" | "ihr" | "sie_sie"; "value": (string | null); "status": "applicable" | "not_applicable" | "unknown"; };

export type ReferenceConjunction = { "meaning_category": GrammarTerm; "verb_position": GrammarTerm; };

export type ReferenceNoun = { "gender": ("masculine" | "feminine" | "neuter" | null); "gender_status": "applicable" | "not_applicable" | "unknown"; "singular": (string | null); "singular_status": "applicable" | "not_applicable" | "unknown"; "plural": (string | null); "plural_status": "applicable" | "not_applicable" | "unknown"; "article_status": "applicable" | "not_applicable" | "unknown"; };

export type ReferencePreposition = { "category": GrammarTerm; "cases": Array<GrammarTerm>; };

export type ReferenceVerb = { "infinitive": (string | null); "infinitive_status": "applicable" | "not_applicable" | "unknown"; "preterite": (string | null); "preterite_status": "applicable" | "not_applicable" | "unknown"; "participle_ii": (string | null); "participle_ii_status": "applicable" | "not_applicable" | "unknown"; "auxiliary": ("haben" | "sein" | null); "auxiliary_status": "applicable" | "not_applicable" | "unknown"; "separability": "separable" | "inseparable" | "unknown"; };

export type RegisterRequest = { "client_instance_id": string; "registration_id": string; };

export type RegisterResponse = { "client_instance_id": string; "status": "registered" | "already_registered"; "origin_proof"?: (string | null); "proof_version": string; "activated": boolean; };

export type RejectedCommandFact = { "id": string; "status": "rejected"; };

export type RemoteSessionCommandResponse = { "command": (SavedCommandFact | RejectedCommandFact); "current": (RemoteSessionProjection | UnavailableSession); "state_version": string; "error"?: (ErrorDetail | null); };

export type RemoteSessionProjection = { "session_id": string; "status": "active" | "summary" | "closed"; "close_reason": ("midnight" | "pair_changed" | "timezone_date_changed" | "stop" | "remote_stop" | "summary_home" | null); };

export type ResultCorrectCommand = { "command_id": string; "client_instance_id": string; "document_id": string; "session_id": string; "kind": "result.correct"; "assignment_id": string; "result_id": string; "expected_result_version": string; "payload": EmptyPayload; };

export type ResultGradeCommand = { "command_id": string; "client_instance_id": string; "document_id": string; "session_id": string; "kind": "result.grade"; "assignment_id": string; "result_id": string; "expected_result_version": string; "payload": ResultGradePayload; };

export type ResultGradePayload = { "grade": number; };

export type RevealedOralAssignment = { "id": string; "card_id": string; "status": "presented"; "kind": "original" | "drill"; "prompt": OralPrompt; "revealed": true; "translations": Array<string>; };

export type SavedCommandFact = { "id": string; "kind": string; "status": "applied" | "already_applied"; "applied_at": string; "target_id": (string | null); "action_id": (string | null); "result_id": (string | null); "context_id": (string | null); "object_version": (string | null); };

export type SessionCommandResponse = { "command": (SavedCommandFact | RejectedCommandFact); "current": (SessionProjection | LearningSessionProjection | OralSessionProjection | ConjugationSessionProjection | UnavailableSession); "state_version": string; "error"?: (ErrorDetail | null); };

export type SessionProjection = { "session_id": string; "status": "active" | "summary" | "closed"; "mode": "written"; "pair": "ru-de" | "uk-de" | "en-de"; "direction": "l1-de"; "local_date": string; "bucket": ("words" | "phrases" | null); "close_reason": ("midnight" | "pair_changed" | "timezone_date_changed" | "stop" | "remote_stop" | "summary_home" | null); "progress": WrittenProgress; "assignment": (PublicAssignment | null); "summary": (WrittenSummary | null); };

export type SessionReference = { "id": string; "phase": "active" | "summary"; };

export type SessionResponse = { "current": (SessionProjection | LearningSessionProjection | OralSessionProjection | ConjugationSessionProjection | UnavailableSession); "state_version": string; };

export type SessionStartCommand = { "command_id": string; "client_instance_id": string; "document_id": string; "session_id": string; "kind": "session.start"; "payload": (SessionStartPayload | LearningStartPayload | OralStartPayload | ConjugationStartPayload); };

export type SessionStartPayload = { "mode": "written"; "bucket": "words" | "phrases"; };

export type SessionStopCommand = { "command_id": string; "client_instance_id": string; "document_id": string; "session_id": string; "kind": "session.stop"; "payload": SessionStopPayload; };

export type SessionStopPayload = { "reason": "stop" | "summary_home"; };

export type SessionStopRemoteCommand = { "command_id": string; "client_instance_id": string; "document_id": string; "session_id": string; "kind": "session.stop_remote"; "payload": SessionStopRemotePayload; };

export type SessionStopRemotePayload = { "confirmed": true; };

export type SettingCommand = { "command_id": string; "kind": "setting.save"; "client_instance_id": string; "document_id": string; "expected_field_version": string; "payload": SettingPayload; };

export type SettingConstraint = { "type": "enum" | "integer" | "boolean" | "ordered_integer_list" | "exclusive_choice"; "values"?: (Array<string> | null); "minimum"?: (number | null); "maximum"?: (number | null); "nonempty"?: (boolean | null); "item_minimum"?: (number | null); "item_maximum"?: (number | null); "modes"?: ({ [key: string]: { [key: string]: (Array<string> | string); }; } | null); };

export type SettingPayload = { "key": "ui_language" | "dictionary_language" | "retry_gap" | "retry_count" | "learning_group_size" | "learning_intervals_seconds" | "learning_poll_seconds" | "learning_reminder_pause_seconds" | "learning_ready_percent" | "learning_mix" | "strict_case" | "include_preterite" | "include_comparative" | "transition_mode" | "review_error_mode" | "material"; "value": (string | number | boolean | Array<number> | (LevelMaterial | TopicsMaterial)); };

export type SettingValue_Literal__strict____soft___ = { "value": "strict" | "soft"; "version": string; };

export type SettingValue_Literal__uk____en____ru___ = { "value": "uk" | "en" | "ru"; "version": string; };

export type SettingValue_Union_Annotated_Union_LevelMaterial__TopicsMaterial___FieldInfo_annotation_NoneType__required_True__discriminator__mode_____NoneType__ = { "value": ((LevelMaterial | TopicsMaterial) | null); "version": string; };

export type SettingValue_Union_Annotated_bool__Strict_strict_True____NoneType__ = { "value": (boolean | null); "version": string; };

export type SettingValue_Union_Annotated_int__Strict_strict_True____NoneType__ = { "value": (number | null); "version": string; };

export type SettingValue_Union_Annotated_str__Strict_strict_True____NoneType__ = { "value": (string | null); "version": string; };

export type SettingValue_Union_Literal__normal____accelerated____NoneType__ = { "value": ("normal" | "accelerated" | null); "version": string; };

export type SettingValue_Union_list_Annotated_int__Strict_strict_True_____NoneType__ = { "value": (Array<number> | null); "version": string; };

export type SettingsCommandResponse = { "command": (SavedCommandFact | RejectedCommandFact); "current": SettingsProjection; "state_version": string; "error"?: (ErrorDetail | null); };

export type SettingsProjection = { "settings": SettingsValues; "needs_setup": boolean; "constraints": { [key: string]: SettingConstraint; }; };

export type SettingsResponse = { "settings": SettingsValues; "needs_setup": boolean; "constraints": { [key: string]: SettingConstraint; }; "state_version": string; };

export type SettingsValues = { "ui_language": SettingValue_Literal__uk____en____ru___; "dictionary_language": SettingValue_Literal__uk____en____ru___; "time_zone": SettingValue_Union_Annotated_str__Strict_strict_True____NoneType__; "retry_gap": SettingValue_Union_Annotated_int__Strict_strict_True____NoneType__; "retry_count": SettingValue_Union_Annotated_int__Strict_strict_True____NoneType__; "learning_group_size": SettingValue_Union_Annotated_int__Strict_strict_True____NoneType__; "learning_intervals_seconds": SettingValue_Union_list_Annotated_int__Strict_strict_True_____NoneType__; "learning_poll_seconds": SettingValue_Union_Annotated_int__Strict_strict_True____NoneType__; "learning_reminder_pause_seconds": SettingValue_Union_Annotated_int__Strict_strict_True____NoneType__; "learning_ready_percent": SettingValue_Union_Annotated_int__Strict_strict_True____NoneType__; "learning_mix": SettingValue_Union_Annotated_bool__Strict_strict_True____NoneType__; "strict_case": SettingValue_Union_Annotated_bool__Strict_strict_True____NoneType__; "include_preterite": SettingValue_Union_Annotated_bool__Strict_strict_True____NoneType__; "include_comparative": SettingValue_Union_Annotated_bool__Strict_strict_True____NoneType__; "transition_mode": SettingValue_Union_Literal__normal____accelerated____NoneType__; "review_error_mode": SettingValue_Literal__strict____soft___; "material": SettingValue_Union_Annotated_Union_LevelMaterial__TopicsMaterial___FieldInfo_annotation_NoneType__required_True__discriminator__mode_____NoneType__; };

export type StatisticsBase = { "total": number; "words": number; "phrases": number; "by_type": StatisticsTypeCounts; };

export type StatisticsOverviewResponse = { "state_version": string; "local_date": string; "pair": "ru-de" | "uk-de" | "en-de"; "time_zone": string; "base": StatisticsBase; "ready": StatisticsReady; "practice": PracticeResponse; };

export type StatisticsReady = { "words": PracticeDirections; "phrases": PracticeDirections; };

export type StatisticsTypeCounts = { "noun": number; "verb": number; "phrase": number; "adjective": number; "pronoun": number; "adverb": number; "preposition": number; "conjunction": number; "particle": number; };

export type StoredCommandFact = { "id": string; "kind": string; "status": "already_applied"; "applied_at": string; "target_id": (string | null); "action_id": (string | null); "result_id": (string | null); "context_id": (string | null); "object_version": (string | null); };

export type SummaryRatio = { "numerator": number; "denominator": number; };

export type TextAnswerPayload = { "text": string; };

export type TodayResponse = { "state_version": string; "pair": "ru-de" | "uk-de" | "en-de"; "local_date": string; "status": "work_now" | "learning_waiting" | "setup_required" | "no_material" | "all_done"; "base": BaseCounts; "ordinary": OrdinaryCounts; "ordinary_status": "ready" | "done"; "learning": LearningCounts; "conjugation": ConjugationCounts; "next_repeat_date": (string | null); };

export type Topic = { "id": string; "number": number; "german_name": string; "description": string; };

export type TopicCatalogResponse = { "topics": Array<Topic>; "state_version": string; };

export type TopicsMaterial = { "mode": "topics"; "topic_ids": Array<string>; };

export type UnavailableCurrent = { "status": "unavailable"; };

export type UnavailableSession = { "session_id": string; "status": "not_found" | "unavailable"; };

export type WrittenAction = { "action_id": string; "kind": "answer.submit"; "version": string; "status": "active" | "undone"; };

export type WrittenAnswerDetail = { "input": (WrittenTextInput | WrittenForgotInput); "initial_check": InitialAnswerCheck; "variants": Array<CompleteAnswerVariant>; "conjunction_hint": (ConjunctionHint | null); "examples": (CardExamples | null); };

export type WrittenCapabilities = { "answer_target": (string | null); "grades": (WrittenGradeCapability | null); "correct_target": (LearningResultTarget | null); "undo_target": null; "stop": boolean; "summary_home": boolean; };

export type WrittenCommandResponse = { "action": (WrittenAction | null); "result": (WrittenResult | null); "step": (WrittenStep | UnavailableSession | UnavailableCurrent); "capabilities": WrittenCapabilities; "command": (SavedCommandFact | RejectedCommandFact); "state_version": string; "error"?: (ErrorDetail | null); };

export type WrittenForgotInput = { "kind": "forgot"; };

export type WrittenGradeCapability = { "session_id": string; "assignment_id": string; "result_id": string; "expected_result_version": string; "values": Array<3 | 4 | 5>; };

export type WrittenPractice = { "pair": "ru-de" | "uk-de" | "en-de"; "direction": "l1-de"; "local_date": string; "time_zone": string; "count": number; };

export type WrittenProgress = { "completed": number; "total": number; "correct": number; "wrong": number; };

export type WrittenResult = { "result_id": string; "assignment_id": string; "version": string; "grade": 2 | 3 | 4 | 5; "correct": boolean; "status": "active" | "undone"; "accepted_at": string; "answer_date": string; "detail": (WrittenAnswerDetail | null); };

export type WrittenResultReadResponse = { "action": (WrittenAction | null); "result": (WrittenResult | null); "step": (WrittenStep | UnavailableSession | UnavailableCurrent); "capabilities": WrittenCapabilities; "state_version": string; };

export type WrittenStatusResponse = { "action": (WrittenAction | null); "result": (WrittenResult | null); "step": (WrittenStep | UnavailableSession | UnavailableCurrent); "capabilities": WrittenCapabilities; "command": StoredCommandFact; "state_version": string; "verified_intent_hash"?: (string | null); };

export type WrittenStep = { "session_id": string; "status": "active" | "summary" | "closed"; "mode": "written"; "pair": "ru-de" | "uk-de" | "en-de"; "direction": "l1-de"; "local_date": string; "bucket": ("words" | "phrases" | null); "close_reason": ("midnight" | "pair_changed" | "timezone_date_changed" | "stop" | "remote_stop" | "summary_home" | null); "progress": WrittenProgress; "assignment": (PublicAssignment | null); "summary": (WrittenSummary | null); "practice": WrittenPractice; "review_progress": (CurrentReviewProgress | null); };

export type WrittenSummary = { "completed": number; "correct": number; "wrong": number; "ratio": (SummaryRatio | null); };

export type WrittenTextInput = { "kind": "text"; "text": string; };

