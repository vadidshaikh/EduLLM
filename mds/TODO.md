# Open Items

## Decisions pending
- [ ] Test the student email rule ("digits in 2nd segment") against real SCET emails, including hyphenated names and middle initials.
- [ ] Decide whether a separate `admin` role is needed. Right now every faculty member can upload and delete documents (see `app/auth/dependencies.py`).
- [ ] Confirm the token lifetimes (now 15 min for magic links, 7 days for sessions).
- [ ] Domain + SSL, if the app must be reachable from outside the campus network.

## Future work
- Chunk-level (partial-document) access control. The schema already supports it because `allowed_roles` lives on `chunks`.
- Finer roles (per department or course): add more `allowed_roles` values. Student dept/year are already in the JWT.
- Output-scanning guardrail as a second layer. Retrieval filtering stays the main control.
- Per-user rate limiting.
- Summarize long conversations (only the last 10 messages are used now).
- Move to a job queue (Celery/RQ + Redis) if FastAPI background tasks can't keep up.
- Load test at ~50 concurrent queries.
