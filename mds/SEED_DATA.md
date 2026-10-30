# Seed data for testing

`backend/scripts/seed_dev_data.py` **wipes the database** (every table) and every uploaded file in
`STORAGE_DIR`, then refills them with data that covers the edge cases. The course content and question
banks are in `backend/scripts/seed_content.py`.

All data goes through `app.db.queries` and the real ingestion pipeline (Docling, then split, then embed).
So scope ids, chunks, audit events and notifications are exactly what the app would produce itself.
Quizzes and assignments use the API's own planner (`_plan`). The script makes no LLM calls.

```bash
cd backend                                   # same CWD as uvicorn, so STORAGE_DIR matches
python scripts/seed_dev_data.py              # asks you to type "wipe"
python scripts/seed_dev_data.py --yes        # no prompt (~8 min, mostly Docling)
python scripts/seed_dev_data.py --yes --no-pdfs   # skip the 4 real PDFs from docs/ (faster)
python scripts/seed_dev_data.py --links      # no reseed: fresh one-time login links for everyone
python scripts/seed_dev_data.py --links aarav.co23d1@scet.ac.in   # ...or for chosen users
```

Login links are one-time and valid for 7 days. You can also log in through the normal email form: with
no `RESEND_API_KEY` set, the link is printed in the uvicorn console. **Join codes are random on every
run**, so read them from the script's output.

Counts after a run: 30 users, 9 workspaces, 7 classrooms, 33 classroom memberships, 24 documents,
77 chunks, 30 audit events, 5 notifications, 8 slide decks, 77 questions (54 MCQ, 23 written), 9 assessments
(5 quizzes, 4 assignments), 33 submissions, 19 conversations.

## People

All addresses are `@scet.ac.in`. Roles come from the email format, as in `app/auth/email_rules.py`.

### Faculty

| Email | Setup | Test |
|---|---|---|
| keyur.rana | Owns **CO Dept - Operating Systems**. Editor in **DBMS Teaching Team**. Has a private doc in his personal workspace. | Main faculty account: answer key, failed and stuck uploads, notes, quizzes |
| priya.shah | Owns **DBMS Teaching Team**. Editor in OS. All notifications read. | Owner vs editor rights |
| amit.patel | Owns **Computer Networks** (draft questions only). Editor in OS. | "Not enough approved questions" errors |
| neha.desai | Personal workspace only. | Empty states. Can see faculty-only institute docs. |
| rahul.mehta | Owns **ML Research Group (empty)**: no docs, notes or classrooms. | Deleting a workspace succeeds |
| sneha.joshi | Invited to the OS workspace but has **never signed in** (no `users` row). | Member list shows no name. First login creates her personal workspace. |

### Students

| Email | Classrooms | Test |
|---|---|---|
| aarav.co23d1 | OS Div 1, OS archived, DBMS CO elective | All notices read, chat history (pinned, untitled, deleted-source) |
| diya.co23d1 | OS Div 1, DBMS CO elective | 12 conversations (sidebar scroll), 1 notice read |
| ishaan / kavya / rohan / sanya / vivaan / ananya / arjun / meera .co23d1 | OS Div 1 (kavya, rohan, sanya also in the DBMS elective) | First 6 of Div 1 were added by a teacher. vivaan, ananya, arjun, meera and isha joined by code (`added_by` NULL). |
| isha.co23d1 | OS Div 1 and DBMS IT | Classrooms in two different workspaces |
| kabir / tara / yash / zoya .co23d2 | OS Div 2 and CN Div 2 | Div 2 isolation (see Access rules) |
| nikhil / pooja .co23d2 | OS Div 2 | |
| ghost.co23d2 | OS Div 2, **never signed in** | Roster shows no name, but a quiz set was still generated for him |
| dev / riya / omkar / sneh .it23a1 | DBMS IT | DBMS assignment, plus a quiz due in 12h |
| late.co23d1 | Joined OS Div 1 **after** its quizzes | Sees the assignment but not Quiz 1/2. Faculty see him under missing students ("add students"). |
| manav.co22d1 | Only in the **archived** OS class | Sees institute docs only, no assessments |
| farhan.co24d1 | None | Joining with a code |
| jay.2023x | None | Student email that doesn't parse into dept/year (`dept`/`year` NULL) |

## Workspaces and classrooms

| Workspace | Classroom | Subject / term | Students |
|---|---|---|---|
| CO Dept - Operating Systems | OS - CO 5th Sem Div 1 | Operating Systems / 2026-27 Odd | 11 + late joiner |
| | OS - CO 5th Sem Div 2 | **same subject + term as Div 1** | 7 (incl. ghost) |
| | OS - 2025-26 Odd (archived) | Operating Systems / 2025-26 Odd, **archived** | 2 |
| | OS Extra Help Sessions | **no subject, no term** | 0 |
| DBMS Teaching Team | DBMS - IT 5th Sem | Database Management Systems / 2026-27 Odd | 5 |
| | DBMS - CO Div 1 (elective) | same subject, **no term** (different rule key) | 3 |
| Computer Networks | Computer Networks - CO Div 2 | Computer Networks / 2026-27 Odd | 4 |
| ML Research Group (empty) | none | | |
| 5 personal "My workspace"s | none | | |

## Documents

| Title | Where | Visibility | State / history |
|---|---|---|---|
| Student Code of Conduct | Institute | institute | indexed (attendance rule: 75%) |
| Department-wise Result Analysis 2025-26 | Institute | institute | indexed. Has a numeric table, for **chart** questions. |
| Faculty Appraisal Guidelines 2026-27 | Institute | **faculty** | indexed |
| B-Tech FY Academic Calendar 2025-26, Overall / Summary of Placement Ratio_2025 | Institute | institute | real PDFs from `docs/` |
| Industrial Visit 2024-25 | Institute | faculty | real PDF |
| Mid-Sem Exam Timetable | Institute | institute | **deleted**: `deleted` notice to everyone. A note and a chat still cite it. |
| OS Unit 1 - Processes and Threads | OS ws | Div 1 + Div 2 | indexed |
| OS Unit 2 - CPU Scheduling | OS ws | Div 1 + Div 2 | **v3** (re-uploaded twice; Div 2 added in v3), `updated` notices |
| OS Unit 3 - Memory Management | OS ws | Div 1 | Access **narrowed** from Div 1 + Div 2 to Div 1 only |
| OS Unit 4 - Deadlocks | OS ws | archived class only | No student can read it |
| OS Mid-Sem Answer Key | OS ws | workspace (faculty) | Contains the secret `ZEBRA-4471` |
| Course Plan | OS ws | Div 1 + Div 2 | **Same title** also exists in the DBMS ws |
| OS Unit 5 - File Systems | OS ws | Div 1 | **stuck: processing 45%**, no chunks |
| Scanned Circular (corrupt file) | OS ws | workspace | **failed** (not a real PDF) |
| CPU Scheduling - Slides | OS ws | Div 1 | published from a deck (.pptx) |
| DBMS Unit 1 / Unit 2 | DBMS ws | IT / IT + CO elective | indexed |
| DBMS Unit 3 - Transactions and Recovery | DBMS ws | workspace | **renamed** from "...Transactions" |
| Course Plan | DBMS ws | IT | duplicate title across workspaces |
| Normalization Cheat Sheet | DBMS ws | workspace | published from a deck (.pptx) |
| Lab Manual (queued) | DBMS ws | workspace | **queued**, never ingested |
| CN Unit 1 - OSI and TCP-IP | CN ws | CN Div 2 | indexed |
| Research Draft - Federated Learning | Keyur's personal ws | workspace | Only Keyur can read it |

## Access rules to verify (leak checks)

- **No student** may get answers from the OS Answer Key (ask "what is the moderation code?"), Faculty
  Appraisal, OS Unit 4, the Research Draft, or DBMS Unit 3.
- **Div 2 (kabir)** can read OS Unit 1, Unit 2 (v3) and the Course Plan. He must not see Memory
  Management or the Scheduling slides.
- **Div 1 (aarav)** can read Units 1-3, the slides and the Course Plan. Unit 4 must not show, even though
  he is in the archived class it is published to.
- **manav** (archived class only) and **farhan** (no class) see institute docs only.
- **neha** (faculty, no shared workspace) sees institute and faculty-only docs, but nothing from any
  shared workspace.
- **priya** (OS editor) sees the OS answer key. **rahul** does not.
- The failed, stuck and queued docs must not appear in anyone's readable/shelf list.

## Notifications

5 notices: 2 for the OS Unit 2 re-uploads, the Unit 3 access change, the DBMS Unit 3 rename, and the
timetable delete. Unread counts after seeding: aarav 0, diya 3, kabir 3, farhan 1, keyur 2, neha 1.
Actors never see their own notices.

## Slide decks

| Workspace | Deck | Case |
|---|---|---|
| OS | Process Synchronization - Slides | Fresh. Created by Keyur, **last edited by Amit**. |
| OS | Scheduling Summary (stale) | Cites OS Unit 2 **v1** (current is v3), so it is stale |
| OS | Timetable Reminder (source deleted) | Source no longer exists (`current_version` null) |
| OS | Empty deck | Empty: publishing must be refused |
| OS | CPU Scheduling - Slides | 5 slides, **published** to Div 1 |
| DBMS | Normalization Cheat Sheet | Published, then **edited after publishing** |
| DBMS | Transactions - Slides (draft) | Unpublished deck |
| Keyur personal | Personal reading list | Deck in a personal workspace |

## Question banks

**Quizzes are multiple choice** (answered and marked in the app). **Assignments are written** short and
long answers, up to 25 questions. They're checked on paper; the app only records who handed them in.
Generate questions asks which style to write.

- **Operating Systems**: 32 approved and 5 draft MCQs, plus 14 approved and 1 draft written questions,
  across Processes, CPU Scheduling, Memory Management, Deadlocks (and a File Systems draft).
  Difficulties 1-3. One draft MCQ has 5 options.
- **Database Management Systems**: 13 approved and 1 draft MCQ, plus 7 approved written questions.
- **Computer Networks**: 3 draft MCQs and 1 draft written question, **0 approved**, so any CN quiz or
  assignment fails with "not enough".

Questions have real embeddings, so the near-duplicate check (similarity > 0.9) is live. Rewording an
existing question should return 409. Approved questions link to their source doc and its first chunks.

## Quizzes (multiple choice)

| Classroom | Quiz | Notes |
|---|---|---|
| OS Div 1 | Quiz 1 - Processes and Scheduling (5 q, max overlap 3, due +2d) | Per-student sets. **late.co23d1 missing.** |
| OS Div 1 | Quiz 2 - Memory Management (4 q, **due -3d, overdue**) | |
| OS Div 2 | Quiz 1 - Deadlocks (3 q, due +1d) | |
| OS Div 2 | Practice Quiz - Easy questions (difficulty 1, **no due date**) | Created by Priya (an editor) |
| DBMS IT | Quiz 1 - DBMS basics (4 q, due +12h) | |

Students answer in the app (Quizzes tab) and submit once. The server marks it. Students see their marks
right away. The correct answers appear only after the due date, or straight away when there is no due
date. A student who misses the due date sees the quiz as closed.

| Quiz | Submissions |
|---|---|
| OS Quiz 1 (open) | aarav **5/5**, diya **0/5**, isha (some blank), ishaan, kavya, rohan. 5 not yet. |
| OS Quiz 2 (overdue) | 9 of 11, before the due date. Answers are visible to them. meera and isha missed it (closed). |
| OS Div 2 Deadlocks | 3 of 7 (ghost hasn't) |
| Practice Quiz (no due date) | kabir: answers visible right after submitting |
| DBMS Quiz 1 | nobody yet |

Faculty: open a quiz to see each student's marks, the submitted count and the class average. Pick a
student to see their set with their answers (wrong picks in red, the correct one in green).

## Assignments (written, checked on paper)

| Classroom | Assignment | Hand-ins |
|---|---|---|
| OS Div 1 | Assignment 1 - Processes and Scheduling (6 q, due +7d) | aarav, diya, isha, ishaan by the students; kavya **ticked off by Keyur**. Others not yet. |
| OS Div 1 | Assignment 2 - Memory and Deadlocks (4 q, **overdue**) | 4 on time, rohan **late**, sanya **ticked off late by Amit**. Others still can (shown as late). |
| OS archived | Assignment - Last year's OS (5 q) | aarav. Old-term rule key, hidden because the class is archived. |
| DBMS IT | Assignment 1 - SQL and Normalization (5 q, due +10d) | dev; riya ticked off by Priya |

Students see the questions (never the model answers), write the answers on paper and **hand in a PDF**
(PDF only, up to 20 MB). They can replace it, and a hand-in after the due date shows as late. Seeded
student hand-ins have a small generated one-page PDF; faculty tick-offs are paper copies with no file.
Faculty see who handed in, when and whether it was late, open each PDF in the in-app viewer, and can tick
off a paper copy or undo a hand-in (undoing deletes the student's PDF). Files are stored under
`STORAGE_DIR/handins/`, and the seed's wipe clears them too.

Left for you to try:

- **OS Div 2 assignment**: it shares Div 1's rule key, so Div 1's 10 written questions are excluded. Only
  4 are left: asking for 5 gives the "only N unused" message, and more than 25 is refused.
- **"Add students"** on OS Div 1 Quiz 1/2 for the late joiner.
- **Deleting a used question** must return 409.
- **CN** quizzes and assignments must fail.
- **OS Extra Help**: no subject, so it fails until a subject is set. No students either.
- The **DBMS CO elective** has no term, so it gets its own rule key.

## Chat history

19 conversations:

- **aarav**: pinned, untitled, and one citing the deleted timetable.
- **isha**: an answer with two sources.
- **keyur**: a pinned conversation with a **bar chart**, and one about the answer key (faculty-only source).
- **farhan**: an answer with no sources.
- **diya**: 12 conversations (one pinned).
