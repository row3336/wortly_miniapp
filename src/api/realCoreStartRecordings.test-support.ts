/**
 * session.start POST exchanges recorded from the real core (TestClient over a disposable schema, CP2 + QA fixes), not
 * hand-built. Source: A-CP2-OLDPARSER recordings/refusal_status_<mode>.json, exchanges "start_held" (applied) and
 * "start_refused" (409 SESSION_BUSY envelope). Request bodies, statuses and replies are verbatim.
 */
export const recordedWrittenStart = {
  "start_held": {
    "request": {
      "client_instance_id": "841849e8-33ec-4e87-bd17-55e936c51fc2",
      "document_id": "ade32526-0999-407c-8f1b-7a4ded9fe2c8",
      "session_id": "bace4259-e8af-4d1f-bfd7-5d1d4a1dd392",
      "command_id": "76c7c443-02d1-4311-95b8-93103b5077bc",
      "kind": "session.start",
      "payload": {
        "mode": "written",
        "bucket": "words"
      }
    },
    "status": 200,
    "reply": {
      "command": {
        "id": "76c7c443-02d1-4311-95b8-93103b5077bc",
        "kind": "session.start",
        "status": "applied",
        "applied_at": "2026-09-29T12:00:00Z",
        "target_id": "bace4259-e8af-4d1f-bfd7-5d1d4a1dd392",
        "action_id": null,
        "result_id": null,
        "context_id": null,
        "object_version": null
      },
      "current": {
        "session_id": "bace4259-e8af-4d1f-bfd7-5d1d4a1dd392",
        "status": "active",
        "mode": "written",
        "pair": "ru-de",
        "direction": "l1-de",
        "local_date": "2026-09-29",
        "bucket": "words",
        "close_reason": null,
        "progress": {
          "completed": 0,
          "total": 1,
          "correct": 0,
          "wrong": 0
        },
        "assignment": {
          "id": "34c25010-b5ac-4b3c-885b-8a401e2667e0",
          "card_id": "8677cdcc-54e9-4d96-86c4-eabac4681343",
          "status": "prefetched",
          "kind": "original",
          "prompt": {
            "text": "дом",
            "language": "ru",
            "translations": [
              "дом"
            ],
            "personal_translation_version": null,
            "conjunction_hint": null
          },
          "answer_spec": {
            "kind": "forms",
            "labels": [
              "Singular",
              "Plural"
            ],
            "part_count": 2,
            "case_sensitive": true
          }
        },
        "summary": null
      },
      "state_version": "4"
    }
  },
  "start_refused": {
    "request": {
      "client_instance_id": "841849e8-33ec-4e87-bd17-55e936c51fc2",
      "document_id": "ade32526-0999-407c-8f1b-7a4ded9fe2c8",
      "session_id": "1d8b5d6b-7dea-4102-93af-7aab3edcbc6c",
      "command_id": "18c87d77-4b1e-48f7-b02a-cb89641b4907",
      "kind": "session.start",
      "payload": {
        "mode": "written",
        "bucket": "words"
      }
    },
    "status": 409,
    "reply": {
      "command": {
        "id": "18c87d77-4b1e-48f7-b02a-cb89641b4907",
        "status": "rejected"
      },
      "current": {
        "session_id": "1d8b5d6b-7dea-4102-93af-7aab3edcbc6c",
        "status": "not_found"
      },
      "state_version": "4",
      "error": {
        "code": "SESSION_BUSY"
      }
    }
  }
} as const;

export const recordedLearningStart = {
  "start_held": {
    "request": {
      "client_instance_id": "daae57ef-57ee-4d76-a6a1-082551cb643b",
      "document_id": "2c20510a-3c78-4882-b0b2-723a77208c32",
      "session_id": "6d8cb90d-92fe-4ae8-ba7c-0f1053342cde",
      "command_id": "d8021e03-7e46-4e21-893f-f44b56295dc5",
      "kind": "session.start",
      "payload": {
        "mode": "learning"
      }
    },
    "status": 200,
    "reply": {
      "command": {
        "id": "d8021e03-7e46-4e21-893f-f44b56295dc5",
        "kind": "session.start",
        "status": "applied",
        "applied_at": "2026-09-29T12:00:00Z",
        "target_id": "6d8cb90d-92fe-4ae8-ba7c-0f1053342cde",
        "action_id": null,
        "result_id": null,
        "context_id": null,
        "object_version": null
      },
      "current": {
        "session_id": "6d8cb90d-92fe-4ae8-ba7c-0f1053342cde",
        "status": "active",
        "mode": "learning",
        "pair": "ru-de",
        "local_date": "2026-09-29",
        "close_reason": null,
        "group": {
          "id": "e3c4e468-ab7d-4939-8086-11e14c37bd70",
          "status": "assembling",
          "version": "1",
          "preview_position": 0,
          "total": 2
        },
        "preview": {
          "id": "c6e97f8b-d802-43ea-84bc-f6d8e2bb2ade",
          "card_id": "c7fb673a-e340-477b-8158-8576934bc9e6",
          "position": 1,
          "total": 2,
          "content": {
            "pair": "ru-de",
            "card": {
              "id": "c7fb673a-e340-477b-8158-8576934bc9e6",
              "revision": "1",
              "lemma": "Hallo0",
              "type": "pronoun",
              "cefr": "A1"
            },
            "translations": {
              "common": [
                "дом"
              ],
              "personal": null
            },
            "grammar": null,
            "reference_conjugations": [],
            "examples": {
              "common": [],
              "personal": null
            },
            "association": null
          }
        },
        "assignment": null
      },
      "state_version": "4"
    }
  },
  "start_refused": {
    "request": {
      "client_instance_id": "daae57ef-57ee-4d76-a6a1-082551cb643b",
      "document_id": "2c20510a-3c78-4882-b0b2-723a77208c32",
      "session_id": "5e17f356-ce4d-4608-8698-b28d26e73f23",
      "command_id": "97398cf9-d0e8-4eda-aa75-46fd990bfd06",
      "kind": "session.start",
      "payload": {
        "mode": "learning"
      }
    },
    "status": 409,
    "reply": {
      "command": {
        "id": "97398cf9-d0e8-4eda-aa75-46fd990bfd06",
        "status": "rejected"
      },
      "current": {
        "session_id": "5e17f356-ce4d-4608-8698-b28d26e73f23",
        "status": "not_found"
      },
      "state_version": "4",
      "error": {
        "code": "SESSION_BUSY"
      }
    }
  }
} as const;

export const recordedOralStart = {
  "start_held": {
    "request": {
      "client_instance_id": "23299a6c-c698-4565-b85c-2641b00126bf",
      "document_id": "18c73979-a195-41a4-b15e-101a2517755b",
      "session_id": "f8fd5e26-1310-49c5-b456-7c4f5c1d2afe",
      "command_id": "21ee5d45-c0c5-4272-9ca3-dd8469b1d071",
      "kind": "session.start",
      "payload": {
        "mode": "oral",
        "bucket": "words"
      }
    },
    "status": 200,
    "reply": {
      "command": {
        "id": "21ee5d45-c0c5-4272-9ca3-dd8469b1d071",
        "kind": "session.start",
        "status": "applied",
        "applied_at": "2026-09-29T12:00:00Z",
        "target_id": "f8fd5e26-1310-49c5-b456-7c4f5c1d2afe",
        "action_id": null,
        "result_id": null,
        "context_id": null,
        "object_version": null
      },
      "current": {
        "session_id": "f8fd5e26-1310-49c5-b456-7c4f5c1d2afe",
        "status": "active",
        "mode": "oral",
        "pair": "ru-de",
        "direction": "de-l1",
        "local_date": "2026-09-29",
        "bucket": "words",
        "close_reason": null,
        "progress": {
          "completed": 0,
          "total": 1,
          "correct": 0,
          "wrong": 0
        },
        "assignment": {
          "id": "bdac1df7-03a0-4bff-9476-cbe2d955b9de",
          "card_id": "50a682b7-6d85-49a7-bdce-3c5289a54d4b",
          "status": "prefetched",
          "kind": "original",
          "prompt": {
            "text": "ich",
            "language": "de",
            "conjunction_hint": null
          },
          "revealed": false
        },
        "summary": null,
        "practice": {
          "pair": "ru-de",
          "direction": "de-l1",
          "local_date": "2026-09-29",
          "time_zone": "UTC",
          "count": 0
        },
        "capabilities": {
          "reveal_target": null,
          "grade_target": null,
          "stop": true,
          "summary_home": false
        }
      },
      "state_version": "4"
    }
  },
  "start_refused": {
    "request": {
      "client_instance_id": "23299a6c-c698-4565-b85c-2641b00126bf",
      "document_id": "18c73979-a195-41a4-b15e-101a2517755b",
      "session_id": "2644b34d-5f1d-406f-ad7b-b742922a5fb4",
      "command_id": "bf44d8b4-d78a-4e85-8198-dc153d3d7a60",
      "kind": "session.start",
      "payload": {
        "mode": "oral",
        "bucket": "words"
      }
    },
    "status": 409,
    "reply": {
      "command": {
        "id": "bf44d8b4-d78a-4e85-8198-dc153d3d7a60",
        "status": "rejected"
      },
      "current": {
        "session_id": "2644b34d-5f1d-406f-ad7b-b742922a5fb4",
        "status": "not_found"
      },
      "state_version": "4",
      "error": {
        "code": "SESSION_BUSY"
      }
    }
  }
} as const;

export const recordedConjugationStart = {
  "start_held": {
    "request": {
      "client_instance_id": "97112cc4-6873-46bc-be84-044fc4c0bbac",
      "document_id": "0ccbda08-d813-448b-9e31-4d12e3c0197e",
      "session_id": "f6bc5b8e-9c14-4ee1-8217-c01905f23b17",
      "command_id": "b2853dfa-d05e-4b23-9a8d-2b3431224539",
      "kind": "session.start",
      "payload": {
        "mode": "conjugation"
      }
    },
    "status": 200,
    "reply": {
      "command": {
        "id": "b2853dfa-d05e-4b23-9a8d-2b3431224539",
        "kind": "session.start",
        "status": "applied",
        "applied_at": "2026-09-29T12:00:00Z",
        "target_id": "f6bc5b8e-9c14-4ee1-8217-c01905f23b17",
        "action_id": null,
        "result_id": null,
        "context_id": null,
        "object_version": null
      },
      "current": {
        "session_id": "f6bc5b8e-9c14-4ee1-8217-c01905f23b17",
        "status": "active",
        "mode": "conjugation",
        "pair": "ru-de",
        "direction": "conjugation",
        "local_date": "2026-09-29",
        "close_reason": null,
        "progress": {
          "completed": 0,
          "total": 6,
          "correct": 0,
          "wrong": 0
        },
        "assignment": {
          "id": "3baba711-c3c9-472f-95c1-be0a5f4f07ab",
          "card_id": "08eda426-e33b-4df6-a03e-bf09d70cccd1",
          "status": "prefetched",
          "kind": "conjugation",
          "cycle_id": "71799ba5-65f1-4cfa-809d-d07f9864b790",
          "slot_id": {
            "cycle_id": "71799ba5-65f1-4cfa-809d-d07f9864b790",
            "pronoun_group": "ich"
          },
          "base_verb_id": "08eda426-e33b-4df6-a03e-bf09d70cccd1",
          "display_verb_id": "08eda426-e33b-4df6-a03e-bf09d70cccd1",
          "tense": "present",
          "pronoun_group": "ich",
          "prompt": {
            "verb": "gehen",
            "translation": "перевод",
            "language": "ru",
            "pronoun": "ich",
            "tense": "present"
          },
          "answer_spec": {
            "kind": "forms",
            "labels": [
              "ich"
            ],
            "part_count": 1,
            "case_sensitive": true
          }
        },
        "summary": null,
        "capabilities": {
          "answer_target": null,
          "correct_target": null,
          "grades": null,
          "undo_target": null,
          "stop": true,
          "summary_home": false
        }
      },
      "state_version": "4"
    }
  },
  "start_refused": {
    "request": {
      "client_instance_id": "97112cc4-6873-46bc-be84-044fc4c0bbac",
      "document_id": "0ccbda08-d813-448b-9e31-4d12e3c0197e",
      "session_id": "e065fae4-62bd-41e5-a651-7cd49708bf5a",
      "command_id": "f2f48bbc-a4e2-47e0-a73b-ced5e99f0255",
      "kind": "session.start",
      "payload": {
        "mode": "conjugation"
      }
    },
    "status": 409,
    "reply": {
      "command": {
        "id": "f2f48bbc-a4e2-47e0-a73b-ced5e99f0255",
        "status": "rejected"
      },
      "current": {
        "session_id": "e065fae4-62bd-41e5-a651-7cd49708bf5a",
        "status": "not_found"
      },
      "state_version": "4",
      "error": {
        "code": "SESSION_BUSY"
      }
    }
  }
} as const;
