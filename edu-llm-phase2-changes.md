# Edu LLM — Phase 2 Change Request

**This is a CHANGE REQUEST against the existing codebase built from `edu-llm-architecture-spec.md`. Modify the existing implementation — do not rebuild from scratch.** Each section below states what to add or change, and where it plugs into the existing LangGraph flow, schema, and API.

---

## 0. Summary of changes

1. Conversation memory — chat actually remembers earlier turns
2. Fix: chart generated on every message regardless of whether real data exists
3. Sidebar with previous chat history
4. Auto-generated chat titles, produced as a LangGraph node
5. Login moves from external-JWT-only to Edu LLM's own email-based login (magic link), with role/department/year derived from the institute email format

---

## 1. Conversation Memory

**Schema — ADD:**

```sql
CREATE TABLE conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_email TEXT NOT NULL,
    title TEXT,                          -- null until auto-generated
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,                  -- 'user' | 'assistant'
    content TEXT NOT NULL,
    chart_config JSONB,                  -- null if no chart
    sources JSONB,                       -- array of {title, doc_id}
    created_at TIMESTAMPTZ DEFAULT now()
);
```

**LangGraph flow — MODIFY:**

The existing flow (`verify_token → resolve_role → retrieve_filtered → generate_answer → parse_chart_config → respond`) is missing two things needed for real multi-turn memory:

- It has no way to load prior turns into state
- A raw follow-up question ("what about for final year students?") will retrieve badly on its own — it needs the conversation context folded in *before* the vector search, not just before generation

Add:

```
load_history          → fetch last N messages for conversation_id from `messages` table into state
condense_query          → LLM call: given chat history + new question, produce a standalone
                           search query. Only runs if history is non-empty. This is what makes
                           follow-ups retrieve correctly instead of just answering blind.
retrieve_filtered        → (existing) now uses the condensed query instead of raw user input
generate_answer           → (existing) now receives both condensed query AND full recent history
                           as context, so it can refer back to earlier parts of the conversation
save_messages              → persist both the user message and assistant response to `messages`
```

**History window**: keep last ~10 messages in state directly; don't try to fit unlimited history into every call — token cost grows fast otherwise. If a conversation gets long, this is a good place for a future summarization step, but not required for this phase.

**API — MODIFY `/query`:**

```
POST /query
  Body: { "conversation_id": string | null, "query": string }
  -- if conversation_id is null, create a new conversation first
  Response: { "conversation_id", "answer", "chart": object|null, "sources": [...] }
```

---

## 2. Fix: Chart Generated on Every Message

**Root cause**: the chart-inclusion rules live entirely inside the main answer-generation prompt. Asking one LLM call to both answer the question *and* correctly self-police whether a chart is warranted is unreliable — the instruction gets ignored under normal generation pressure, which is what you're seeing.

**Fix — decouple the decision from the generation, and add a deterministic backstop:**

```
generate_answer      → (existing) produce the text answer. REMOVE all chart-inclusion logic
                        from this prompt — it should just answer the question well.
should_chart          → NEW small classifier call (fast/cheap model, low temperature):
                        given the question + the answer text + the retrieved context,
                        output ONLY yes/no: does this specifically call for a chart, per the
                        original criteria (explicit request for stats/comparison/trend AND
                        real numeric data present in context)?
generate_chart          → NEW: only runs if should_chart == yes. Produces the [GRAPH_CONFIG]
                        block from the same context.
validate_chart_data      → NEW deterministic check (plain code, not an LLM call): every numeric
                        value in the generated chart's data array must appear in the retrieved
                        context chunks. If any value can't be matched, DROP the chart entirely
                        rather than send fabricated numbers to the user. This is the real
                        guardrail — don't rely on prompt compliance alone twice in a row.
```

This costs one extra small LLM call per message but should eliminate spurious charts, since the decision is now a dedicated yes/no classification instead of a side-instruction inside a longer generation task.

Keep your original chart-type rules (line/bar/pie) and JSON format exactly as they are — only move *where* the decision happens, not the criteria themselves.

---

## 3. Sidebar — Previous Chat History

**API — ADD:**

```
GET /conversations
  Response: [{ "id", "title", "updated_at" }, ...]   -- scoped to the logged-in user's email
  Sort: most recently updated first

GET /conversations/{id}/messages
  Response: [{ "role", "content", "chart_config", "sources", "created_at" }, ...]

DELETE /conversations/{id}
```

**Frontend — ADD:**

- Left sidebar, collapsible, listing conversations by title with relative timestamps ("2 hours ago")
- Clicking a conversation loads its messages into the main pane and sets it as the active `conversation_id` for subsequent queries
- "New chat" button clears active conversation, starts fresh (conversation_id null until first message)
- Keep this list visually quiet — small text, muted color per the existing dark palette, this is navigation not content

---

## 4. Auto-Generated Chat Titles

**LangGraph — ADD node**, triggered after the first exchange in a conversation only:

```
generate_title    → runs only when conversation.title IS NULL after save_messages.
                    Small LLM call: given the first user question + first answer, produce a
                    short title (≤6 words, no punctuation at the end, no quotes around it).
                    Update conversations.title.
```

Run this **asynchronously** after the response is already sent back to the user — don't make them wait on a title generation call before they see their answer. The sidebar can show "New conversation" as a placeholder until the title updates, then refresh.

---

## 5. Email-Based Login

**Supersedes Phase 1's assumption of a fully external auth service.** Edu LLM now owns login. Role, department, admission year, and division are derived directly from the institute email address — no manual role assignment needed.

### Email format rules (SCET)

- **Faculty**: `firstname.lastname@scet.ac.in` — local part is two word segments separated by a dot, neither containing digits
- **Student**: `name.co23d1@scet.ac.in` — local part is `name.<deptyeardivision>`, where the second segment contains digits (e.g. `co23d1` = dept `co`, admission year `23`, division `d`, class/section `1`)

**Derivation logic (code, not hardcoded regex per department)**: split local part on `.`; if the second segment contains any digit → student, else → faculty. This avoids having to enumerate every department code (co, it, ex, me, etc.) up front — more robust than a rigid pattern.

For students, further parse the second segment into `{dept, year, division, section}` using a pattern like `^([a-z]+)(\d{2})([a-z])(\d)$` — capture these even though they're not used for access filtering yet, since it's free metadata for the future per-department granularity noted as an open item in the original spec.

**Domain check**: reject anything not ending in `@scet.ac.in`, regardless of local-part shape.

### Login flow

```
1. User enters their institute email.
2. Backend validates domain + derives role (and dept/year/division if student).
3. Backend generates a short-lived signed login token, emails a magic link
   (e.g. https://edullm.scet.ac.in/auth/verify?token=...) to that address.
4. User clicks the link within the expiry window (recommend 15 minutes).
5. Backend verifies the token, issues Edu LLM's own session JWT
   (claims: email, role, dept, year, division, exp), sets it as the session token.
6. All existing downstream logic (role-filtered retrieval, admin-only routes) is UNCHANGED —
   it already expected a verified JWT with a role claim. Only the issuer changes.
```

**Schema — ADD:**

```sql
CREATE TABLE login_tokens (
    token TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used BOOLEAN DEFAULT FALSE
);
```

(No permanent `users` table strictly required yet — identity is just the verified email each time. Add one later only if you need persistent per-user settings beyond conversation history, which is already keyed on `user_email`.)

---

## 6. Manual Action Items for This Phase

- [ ] Confirm the second-segment student pattern (`co23d1`-style) against a real sample of SCET student emails across a few departments — the derivation logic assumes "digits in second segment = student" and doesn't hardcode department codes, but worth sanity-checking against edge cases (e.g. hyphenated names, faculty with a middle initial)
- [ ] Set up an email-sending service (SMTP creds, or SendGrid/AWS SES) for the magic link — decide which now
- [ ] Decide magic-link expiry window (recommended default: 15 minutes) and session JWT lifetime (recommended default: 7 days, since students will use this repeatedly)
- [ ] Confirm whether the previously-planned separate auth service is still being built for anything else, or whether Edu LLM's own login fully replaces that plan

---

## 7. Non-Goals for This Phase

Not changing in this pass: role-filtering-before-retrieval mechanism, vector store choice, chunk-level ACL (still an open item from Phase 1), Docker Compose deployment shape.
