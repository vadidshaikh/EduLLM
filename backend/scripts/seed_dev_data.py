"""Wipe the database and fill it with test data covering the edge cases.

DESTRUCTIVE: every table is emptied and every uploaded file in STORAGE_DIR
is deleted first. Dev databases only.

Everything goes through app.db.queries and the real ingestion pipeline, so
scope ids, chunks, embeddings, audit events and notifications are exactly
what the app itself would have produced. Quizzes and assignments are built
with the same planner the API uses. No LLM calls are made.

Usage (from backend/, like the server, so STORAGE_DIR resolves the same way):
    python scripts/seed_dev_data.py              # asks before wiping
    python scripts/seed_dev_data.py --yes        # no prompt
    python scripts/seed_dev_data.py --yes --no-pdfs   # skip the slower real PDFs
    python scripts/seed_dev_data.py --links      # only issue fresh login links

Login links are one-time; run with --links (optionally --links EMAIL ...) to
get new ones without reseeding. See the printed summary for what each account
is meant to test.
"""
from __future__ import annotations

import argparse
import logging
import random
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import UUID

import numpy as np
import psycopg
from psycopg.types.json import Json

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import seed_content as C  # noqa: E402  (same folder)

from app.api.assessments import _plan  # noqa: E402
from app.api.schemas import AssessmentConfig  # noqa: E402
from app.assessments.generate import DUPLICATE_SIMILARITY, question_text  # noqa: E402
from app.auth.email_rules import display_name_from_email, parse_institute_email  # noqa: E402
from app.auth.magic_link import generate_login_token  # noqa: E402
from app.authoring.render import deck_pptx  # noqa: E402
from app.config import settings  # noqa: E402
from app.db import queries  # noqa: E402
from app.db.pool import pool  # noqa: E402
from app.ingestion.embedder import embed_texts  # noqa: E402
from app.ingestion.pipeline import run_ingestion  # noqa: E402
from app.storage import compute_file_hash, save_handin_file, save_upload_file, storage_dir  # noqa: E402

BACKEND = Path(__file__).resolve().parent.parent
SCHEMA_PATH = BACKEND / "db" / "schema.sql"
DOCS_DIR = BACKEND.parent / "docs"
NOW = datetime.now(tz=timezone.utc)
TERM = "2026-27 Odd"
LINK_EXPIRY_MINUTES = 7 * 24 * 60

TABLES = [
    "assessment_items", "assessments", "questions", "notes", "notification_reads", "notifications",
    "document_events", "chunks", "documents", "classroom_members", "classrooms", "workspace_members",
    "workspaces", "messages", "conversations", "login_tokens", "users", "submissions",
]

# --- People ----------------------------------------------------------------

F_KEYUR = "keyur.rana@scet.ac.in"      # owns OS workspace, editor in DBMS
F_PRIYA = "priya.shah@scet.ac.in"      # owns DBMS workspace, editor in OS
F_AMIT = "amit.patel@scet.ac.in"       # owns CN workspace, editor in OS
F_NEHA = "neha.desai@scet.ac.in"       # personal workspace only
F_RAHUL = "rahul.mehta@scet.ac.in"     # owns an empty shared workspace (deletable)
F_SNEHA = "sneha.joshi@scet.ac.in"     # invited to OS workspace, never signed in (no users row)
FACULTY = [F_KEYUR, F_PRIYA, F_AMIT, F_NEHA, F_RAHUL]

CO_D1 = [f"{n}.co23d1@scet.ac.in" for n in
         ["aarav", "diya", "ishaan", "kavya", "rohan", "sanya", "vivaan", "ananya", "arjun", "meera"]]
CO_D2 = [f"{n}.co23d2@scet.ac.in" for n in ["kabir", "tara", "yash", "zoya", "nikhil", "pooja"]]
IT_A1 = [f"{n}.it23a1@scet.ac.in" for n in ["dev", "riya", "omkar", "sneh"]]
S_ISHA = "isha.co23d1@scet.ac.in"      # in OS Div 1 AND DBMS IT (two workspaces)
S_MANAV = "manav.co22d1@scet.ac.in"    # only in an archived classroom
S_FARHAN = "farhan.co24d1@scet.ac.in"  # in no classroom at all
S_JAY = "jay.2023x@scet.ac.in"         # student email that doesn't parse into dept/year
S_LATE = "late.co23d1@scet.ac.in"      # joined OS Div 1 after Quiz 1 was handed out
S_GHOST = "ghost.co23d2@scet.ac.in"    # added by a teacher, never signed in (no users row)
STUDENTS = [*CO_D1, *CO_D2, *IT_A1, S_ISHA, S_MANAV, S_FARHAN, S_JAY, S_LATE]
NEVER_SIGNED_IN = [F_SNEHA, S_GHOST]

NAMES = {F_KEYUR: "Keyur Rana", F_PRIYA: "Priya Shah", F_AMIT: "Amit Patel", F_NEHA: "Neha Desai",
         F_RAHUL: "Rahul Mehta"}


def name(email: str) -> str:
    return NAMES.get(email) or display_name_from_email(email)


def actor(email: str) -> dict:
    return {"actor_email": email, "actor_name": name(email)}


def step(msg: str) -> None:
    print(f"\n== {msg}")


# --- Wipe ------------------------------------------------------------------


def wipe() -> None:
    step("Applying schema and wiping all data")
    with psycopg.connect(settings.DATABASE_URL, autocommit=True) as conn:
        conn.execute(SCHEMA_PATH.read_text())
        # TRUNCATE doesn't fire the row-level append-only triggers.
        conn.execute(f"TRUNCATE {', '.join(TABLES)} CASCADE")
    removed = 0
    for path in [*storage_dir().iterdir(), *(storage_dir() / "handins").glob("*")]:
        if path.is_file() and path.name != ".gitkeep":
            path.unlink()
            removed += 1
    print(f"   tables emptied, {removed} stored file(s) removed from {storage_dir().resolve()}")


# --- Users, workspaces, classrooms -----------------------------------------


def seed_users() -> None:
    step("Users")
    for email in [*FACULTY, *STUDENTS]:
        claims = parse_institute_email(email)
        queries.upsert_user(email=email, name=name(email), role=claims["role"], dept=claims.get("dept"),
                            year=claims.get("year"), division=claims.get("division"))
        if claims["role"] == "faculty":
            queries.ensure_personal_workspace(email)
    with pool.connection() as conn:
        # Spread sign-up / last-login times so lists don't all show "just now".
        for i, email in enumerate([*FACULTY, *STUDENTS]):
            conn.execute(
                "UPDATE users SET created_at = %s, last_login_at = %s WHERE email = %s",
                (NOW - timedelta(days=60 - i), NOW - timedelta(hours=i * 7), email),
            )
        conn.commit()
    print(f"   {len(FACULTY)} faculty, {len(STUDENTS)} students "
          f"(+ {len(NEVER_SIGNED_IN)} invited but never signed in: {', '.join(NEVER_SIGNED_IN)})")


def personal_ws(email: str) -> UUID:
    return next(w["id"] for w in queries.list_workspaces(email) if w["kind"] == "personal")


def seed_workspaces() -> dict:
    step("Workspaces and classrooms")
    ws = {
        "os": queries.create_shared_workspace("CO Dept - Operating Systems", F_KEYUR),
        "dbms": queries.create_shared_workspace("DBMS Teaching Team", F_PRIYA),
        "cn": queries.create_shared_workspace("Computer Networks", F_AMIT),
        "ml": queries.create_shared_workspace("ML Research Group (empty)", F_RAHUL),
        "keyur_personal": personal_ws(F_KEYUR),
        "neha_personal": personal_ws(F_NEHA),
    }
    for member in [F_PRIYA, F_AMIT, F_SNEHA]:
        queries.add_workspace_member(ws["os"], member, F_KEYUR)
    queries.add_workspace_member(ws["dbms"], F_KEYUR, F_PRIYA)

    def classroom(key, name_, subject, term, by):
        return queries.create_classroom(workspace_id=ws[key], name=name_, subject=subject, term=term, created_by=by)

    cr = {
        "os_d1": classroom("os", "OS - CO 5th Sem Div 1", "Operating Systems", TERM, F_KEYUR),
        # Same subject + term as Div 1, so assignments can't reuse Div 1's questions.
        "os_d2": classroom("os", "OS - CO 5th Sem Div 2", "Operating Systems", TERM, F_AMIT),
        "os_old": classroom("os", "OS - 2025-26 Odd (archived)", "Operating Systems", "2025-26 Odd", F_KEYUR),
        # No subject, no term, no students.
        "os_help": classroom("os", "OS Extra Help Sessions", None, None, F_PRIYA),
        "dbms_it": classroom("dbms", "DBMS - IT 5th Sem", "Database Management Systems", TERM, F_PRIYA),
        # Same subject, no term: a different assignment rule key.
        "dbms_co": classroom("dbms", "DBMS - CO Div 1 (elective)", "Database Management Systems", None, F_KEYUR),
        "cn_d2": classroom("cn", "Computer Networks - CO Div 2", "Computer Networks", TERM, F_AMIT),
    }
    cr = {k: v["id"] for k, v in cr.items()}

    # Teacher-added vs joined-with-code (added_by NULL).
    queries.add_classroom_students(cr["os_d1"], CO_D1[:6], F_KEYUR)
    queries.add_classroom_students(cr["os_d1"], [*CO_D1[6:], S_ISHA], None)
    queries.add_classroom_students(cr["os_d2"], [*CO_D2, S_GHOST], F_AMIT)
    queries.add_classroom_students(cr["os_old"], [S_MANAV, CO_D1[0]], F_KEYUR)
    queries.add_classroom_students(cr["dbms_it"], [*IT_A1, S_ISHA], F_PRIYA)
    queries.add_classroom_students(cr["dbms_co"], CO_D1[:3], None)
    queries.add_classroom_students(cr["cn_d2"], CO_D2[:4], F_AMIT)
    print("   OS ws: Div 1 (11), Div 2 (7 incl. ghost), archived (2), extra-help (0)")
    print("   DBMS ws: IT (5), CO elective (3, no term) | CN ws: Div 2 (4) | ML ws: nothing")
    return {"ws": ws, "cr": cr}


# --- Documents -------------------------------------------------------------


def upload(title: str, filename: str, data: bytes, *, ws: UUID | None, visibility: str,
           classrooms: list[UUID] = (), by: str) -> dict:
    path = save_upload_file(data, filename)
    return queries.insert_document(
        title=title, filename=filename, storage_path=str(path), workspace_id=ws, visibility=visibility,
        classroom_ids=list(classrooms), file_hash=compute_file_hash(data), **actor(by),
    )


def md(text: str) -> bytes:
    return text.encode()


def ingest(doc_ids: list[UUID]) -> None:
    for i, doc_id in enumerate(doc_ids, 1):
        run_ingestion(doc_id)
        doc = queries.get_document(doc_id)
        print(f"   [{i}/{len(doc_ids)}] {doc['status']:<8} {doc['title']}")


def seed_documents(ctx: dict, with_pdfs: bool) -> dict:
    step("Documents (real ingestion: parse -> split -> embed)")
    ws, cr = ctx["ws"], ctx["cr"]
    d: dict[str, dict] = {}
    to_ingest: list[UUID] = []

    def add(key, title, text, **kw):
        d[key] = upload(title, f"{title}.md", md(text), **kw)
        to_ingest.append(d[key]["id"])

    # Institute library
    add("conduct", "Student Code of Conduct", C.INSTITUTE_CODE_OF_CONDUCT, ws=None, visibility="institute", by=F_KEYUR)
    add("results", "Department-wise Result Analysis 2025-26", C.INSTITUTE_RESULTS, ws=None, visibility="institute", by=F_PRIYA)
    add("appraisal", "Faculty Appraisal Guidelines 2026-27", C.FACULTY_APPRAISAL, ws=None, visibility="faculty", by=F_RAHUL)
    add("timetable", "Mid-Sem Exam Timetable", C.OLD_TIMETABLE, ws=None, visibility="institute", by=F_KEYUR)
    if with_pdfs:
        for fname, vis in [("B-Tech FY Academic Calendar 2025-26.pdf", "institute"),
                           ("Overall Placement Ratio_2025.pdf", "institute"),
                           ("Summary of Placement Ratio_2025.pdf", "institute"),
                           ("Industrial Visit 2024-25.pdf", "faculty")]:
            src = DOCS_DIR / fname
            if src.exists():
                doc = upload(src.stem, src.name, src.read_bytes(), ws=None, visibility=vis, by=F_KEYUR)
                to_ingest.append(doc["id"])

    # OS workspace
    add("os1", "OS Unit 1 - Processes and Threads", C.OS_UNIT1, ws=ws["os"], visibility="classrooms",
        classrooms=[cr["os_d1"], cr["os_d2"]], by=F_KEYUR)
    add("os2", "OS Unit 2 - CPU Scheduling", C.OS_UNIT2_V1, ws=ws["os"], visibility="classrooms",
        classrooms=[cr["os_d1"]], by=F_KEYUR)
    add("os3", "OS Unit 3 - Memory Management", C.OS_UNIT3, ws=ws["os"], visibility="classrooms",
        classrooms=[cr["os_d1"], cr["os_d2"]], by=F_AMIT)
    add("os4", "OS Unit 4 - Deadlocks", C.OS_UNIT4, ws=ws["os"], visibility="classrooms",
        classrooms=[cr["os_old"]], by=F_KEYUR)
    add("os_key", "OS Mid-Sem Answer Key", C.OS_ANSWER_KEY, ws=ws["os"], visibility="workspace", by=F_KEYUR)
    add("os_plan", "Course Plan", C.OS_COURSE_PLAN, ws=ws["os"], visibility="classrooms",
        classrooms=[cr["os_d1"], cr["os_d2"]], by=F_KEYUR)

    # DBMS workspace ("Course Plan" again: same title, different workspace)
    add("db1", "DBMS Unit 1 - Relational Model and SQL", C.DBMS_UNIT1, ws=ws["dbms"], visibility="classrooms",
        classrooms=[cr["dbms_it"]], by=F_PRIYA)
    add("db2", "DBMS Unit 2 - Normalization", C.DBMS_UNIT2, ws=ws["dbms"], visibility="classrooms",
        classrooms=[cr["dbms_it"], cr["dbms_co"]], by=F_PRIYA)
    add("db3", "DBMS Unit 3 - Transactions", C.DBMS_UNIT3, ws=ws["dbms"], visibility="workspace", by=F_KEYUR)
    add("db_plan", "Course Plan", C.DBMS_COURSE_PLAN, ws=ws["dbms"], visibility="classrooms",
        classrooms=[cr["dbms_it"]], by=F_PRIYA)

    add("cn1", "CN Unit 1 - OSI and TCP-IP", C.CN_UNIT1, ws=ws["cn"], visibility="classrooms",
        classrooms=[cr["cn_d2"]], by=F_AMIT)
    add("research", "Research Draft - Federated Learning", C.RESEARCH_DRAFT, ws=ws["keyur_personal"],
        visibility="workspace", by=F_KEYUR)

    # A file Docling can't parse -> status 'failed'.
    bad = upload("Scanned Circular (corrupt file)", "circular.pdf", b"%PDF-1.4 this is not really a pdf",
                 ws=ws["os"], visibility="workspace", by=F_AMIT)
    to_ingest.append(bad["id"])

    ingest(to_ingest)

    step("Document history: re-uploads, access changes, rename, delete, stuck uploads")
    # OS Unit 2 re-uploaded twice -> v3, 'updated' notices to Div 1 (and then Div 2 as well).
    for text, rooms, by in [(C.OS_UNIT2_V2, [cr["os_d1"]], F_PRIYA),
                            (C.OS_UNIT2_V3, [cr["os_d1"], cr["os_d2"]], F_KEYUR)]:
        d["os2"] = upload("OS Unit 2 - CPU Scheduling", "OS Unit 2 - CPU Scheduling.md", md(text),
                          ws=ws["os"], visibility="classrooms", classrooms=rooms, by=by)
    ingest([d["os2"]["id"]])
    print(f"   OS Unit 2 is now v{d['os2']['version']} (published to both divisions)")

    # Memory Management pulled back from Div 2 (still Div 1).
    queries.update_document(d["os3"]["id"], title=None, visibility="classrooms",
                            classroom_ids=[cr["os_d1"]], **actor(F_KEYUR))
    # Transactions renamed (workspace-only throughout).
    queries.update_document(d["db3"]["id"], title="DBMS Unit 3 - Transactions and Recovery", visibility=None,
                            classroom_ids=None, **actor(F_PRIYA))
    # Institute doc deleted -> 'deleted' notice to everyone; a note still cites it.
    timetable_id = d["timetable"]["id"]
    deleted = queries.delete_document(timetable_id, **actor(F_KEYUR))
    Path(deleted["storage_path"]).unlink(missing_ok=True)
    print("   OS Unit 3 narrowed to Div 1, DBMS Unit 3 renamed, 'Mid-Sem Exam Timetable' deleted")

    # Stuck uploads: one 'processing' at 45%, one still 'queued' (no chunks).
    stuck = upload("OS Unit 5 - File Systems", "OS Unit 5 - File Systems.md", md(C.OS_UNIT5),
                   ws=ws["os"], visibility="classrooms", classrooms=[cr["os_d1"]], by=F_AMIT)
    queries.update_document_status(stuck["id"], "processing", progress=45)
    upload("Lab Manual (queued)", "Lab Manual.md", md("# Lab manual\n\nTo be indexed."),
           ws=ws["dbms"], visibility="workspace", by=F_PRIYA)
    print("   'OS Unit 5' stuck at processing 45%, 'Lab Manual (queued)' left queued")

    d["timetable"] = {"id": timetable_id, "title": "Mid-Sem Exam Timetable", "version": 1}
    return d


def seed_notification_reads() -> None:
    step("Notification read state")
    queries.mark_notifications_read(CO_D1[0], "student")          # aarav: everything read
    first = queries.list_notifications(CO_D1[1], "student", 50)   # diya: one read, rest unread
    if first:
        queries.mark_notifications_read(CO_D1[1], "student", first[-1]["id"])
    queries.mark_notifications_read(F_PRIYA, "faculty")
    for email, role in [(CO_D1[0], "student"), (CO_D1[1], "student"), (CO_D2[0], "student"),
                        (S_FARHAN, "student"), (F_KEYUR, "faculty"), (F_NEHA, "faculty")]:
        print(f"   {email:<28} unread {queries.count_unread_notifications(email, role)}")


# --- Notes -----------------------------------------------------------------


def src(doc: dict, version: int | None = None) -> dict:
    return {"doc_id": str(doc["id"]), "title": doc["title"], "version": version or doc["version"]}


def publish(note_id: UUID, *, visibility: str, classrooms: list[UUID] = (), by: str) -> UUID:
    note = queries.get_note(note_id)
    doc = upload(note["title"], f"{note['title']}.pptx", deck_pptx(note), ws=note["workspace_id"], visibility=visibility,
                 classrooms=classrooms, by=by)
    queries.set_note_published(note_id, doc["id"])
    return doc["id"]


def seed_notes(ctx: dict, d: dict) -> None:
    step("Slide decks")
    ws, cr = ctx["ws"], ctx["cr"]

    def note(key, title, topic, *, slides=(), sources=(), by, subject=None):
        return queries.insert_note(workspace_id=ws[key], kind="slides", title=title, subject=subject, topic=topic,
                                   body_md="", slides=list(slides), sources=list(sources), actor_email=by)

    fresh = note("os", "Process Synchronization - Slides", "Process synchronization",
                 slides=C.SLIDES_SYNC, sources=[src(d["os1"])], by=F_KEYUR, subject="Operating Systems")
    # Edited by another member (updated_by != created_by).
    current = queries.get_note(fresh)
    extra = {"title": "Peterson's solution", "bullets": ["Two processes", "flag[] and turn"], "notes": ""}
    queries.update_note(fresh, {"slides": [*C.SLIDES_SYNC, extra]},
                        base_updated_at=current["updated_at"], actor_email=F_AMIT)

    note("os", "Scheduling Summary (stale)", "CPU scheduling", slides=C.SLIDES_SCHEDULING_SUMMARY,
         sources=[src(d["os2"], version=1)], by=F_PRIYA, subject="Operating Systems")
    note("os", "Timetable Reminder (source deleted)", "Exams", slides=C.SLIDES_TIMETABLE_REMINDER,
         sources=[src(d["timetable"])], by=F_KEYUR)
    note("os", "Empty deck", "Placeholder", by=F_AMIT)  # no slides: can't be published

    deck = note("os", "CPU Scheduling - Slides", "CPU scheduling algorithms", slides=C.SLIDES_SCHEDULING,
                sources=[src(d["os2"])], by=F_KEYUR, subject="Operating Systems")
    deck_doc = publish(deck, visibility="classrooms", classrooms=[cr["os_d1"]], by=F_KEYUR)

    cheat = note("dbms", "Normalization Cheat Sheet", "Normal forms", slides=C.SLIDES_NORMALIZATION,
                 sources=[src(d["db2"])], by=F_PRIYA, subject="Database Management Systems")
    cheat_doc = publish(cheat, visibility="workspace", by=F_PRIYA)
    # Edited after publishing (the published doc is now behind the note).
    current = queries.get_note(cheat)
    fourth = {"title": "Beyond BCNF", "bullets": ["4NF: no multi-valued dependencies"], "notes": ""}
    queries.update_note(cheat, {"slides": [*C.SLIDES_NORMALIZATION, fourth]},
                        base_updated_at=current["updated_at"], actor_email=F_KEYUR)

    note("dbms", "Transactions - Slides (draft)", "Transactions", slides=C.SLIDES_TRANSACTIONS,
         sources=[src(queries.get_document(d["db3"]["id"]))], by=F_KEYUR, subject="Database Management Systems")
    note("keyur_personal", "Personal reading list", "Research",
         slides=[{"title": "Reading list", "bullets": ["FedAvg paper", "FedProx paper"], "notes": ""}],
         sources=[src(d["research"])], by=F_KEYUR)

    ingest([deck_doc, cheat_doc])
    print("   OS ws: fresh (edited by Amit), stale, deleted-source, empty, published deck")
    print("   DBMS ws: published-then-edited deck, draft deck | Keyur personal: one deck")


# --- Question bank and assessments -----------------------------------------


def seed_questions(ctx: dict, d: dict) -> None:
    step("Question banks (real embeddings, near-duplicates refused like the API)")
    ws = ctx["ws"]
    topic_doc = {"Processes": d["os1"], "CPU Scheduling": d["os2"], "Memory Management": d["os3"],
                 "Deadlocks": d["os4"], "Relational Model": d["db1"], "Normalization": d["db2"],
                 "Transactions": d["db3"], "OSI Model": d["cn1"], "Transport Layer": d["cn1"]}
    with pool.connection() as conn:
        chunk_ids = {
            r["document_id"]: r["ids"]
            for r in conn.execute("SELECT document_id, array_agg(id ORDER BY chunk_index) AS ids "
                                  "FROM chunks GROUP BY document_id").fetchall()
        }

    def bank(key, subject, approved, drafts, by, approver):
        items = [(q, True) for q in approved] + [(q, False) for q in drafts]
        bodies = [{"prompt": q["prompt"], **({"options": q["options"]} if q["type"] == "mcq" else {})}
                  for q, _ in items]
        vectors = np.array(embed_texts([question_text(b) for b in bodies]), dtype=float)
        vectors /= np.linalg.norm(vectors, axis=1, keepdims=True)
        kept, kept_vecs, to_approve = [], [], []
        for (q, ok), body, vec in zip(items, bodies, vectors):
            if kept_vecs and float(np.max(np.array(kept_vecs) @ vec)) > DUPLICATE_SIMILARITY:
                print(f"   ! skipped near-duplicate: {q['prompt'][:70]}")
                continue
            kept_vecs.append(vec)
            doc = topic_doc.get(q["topic"])
            kept.append(({
                "type": q["type"], "difficulty": q["difficulty"], "body": body,
                "answer": {"correct": q["correct"], "explanation": q["explanation"]},
                "embedding": vec.tolist(),
                "source_doc_ids": [doc["id"]] if doc else [],
                "source_chunk_ids": chunk_ids.get(doc["id"], [])[:2] if doc else [],
            }, q["topic"], ok))
        ids = []
        for question, topic, ok in kept:
            [qid] = queries.insert_questions(workspace_id=ws[key], actor_email=by,
                                             questions=[{**question, "subject": subject, "topic": topic}])
            ids.append(qid)
            if ok:
                to_approve.append(qid)
        if to_approve:
            queries.set_questions_status(ws[key], to_approve, "approved", actor_email=approver)
        print(f"   {subject:<28} {len(to_approve)} approved, {len(ids) - len(to_approve)} draft")

    bank("os", "Operating Systems", [*C.OS_QUESTIONS_APPROVED, *C.OS_WRITTEN_APPROVED],
         [*C.OS_QUESTIONS_DRAFT, *C.OS_WRITTEN_DRAFT], F_KEYUR, F_PRIYA)
    bank("dbms", "Database Management Systems", [*C.DBMS_QUESTIONS_APPROVED, *C.DBMS_WRITTEN_APPROVED],
         C.DBMS_QUESTIONS_DRAFT, F_PRIYA, F_PRIYA)
    bank("cn", "Computer Networks", [], [*C.CN_QUESTIONS_DRAFT, *C.CN_WRITTEN_DRAFT], F_AMIT, F_AMIT)


def make_assessment(classroom_key: str, ctx: dict, *, title: str, by: str, due_days: float | None = None,
                    **config) -> UUID | None:
    classroom = queries.get_classroom(ctx["cr"][classroom_key])
    cfg = AssessmentConfig(**config)
    plan = _plan(classroom, cfg)
    if not plan["ok"] and cfg.max_overlap is not None:
        print(f"   ! {title}: {plan['message']} - retrying without the overlap cap")
        cfg = cfg.model_copy(update={"max_overlap": None})
        plan = _plan(classroom, cfg)
    if not plan["ok"]:
        print(f"   ! {title}: not created - {plan['message']}")
        return None
    stored = cfg.model_dump(include={"count", "topics", "difficulties", "max_overlap"})
    stored["types"] = ["mcq"] if cfg.kind == "quiz" else ["short", "long"]
    if cfg.kind == "assignment":
        stored["max_overlap"] = None
    assessment_id = queries.insert_assessment(
        classroom_id=classroom["id"], kind=cfg.kind, title=title, subject=plan["subject"], key=plan["key"],
        config=stored, seed=plan["seed"], due_at=NOW + timedelta(days=due_days) if due_days is not None else None,
        actor_email=by, sets=plan["sets"],
    )
    print(f"   {cfg.kind:<10} {title:<44} {plan['message']}")
    return assessment_id


def submit(assessment_id: UUID | None, email: str, rng: random.Random, *, right: float, blank: float = 0,
           days_ago: float = 0) -> None:
    """A graded submission for `email`: each question right with chance
    `right`, blank with chance `blank`, otherwise a wrong option."""
    if assessment_id is None:
        return
    a = queries.get_student_assessment(assessment_id, email, with_answers=True)
    answers, score = [], 0
    for item in a["items"]:
        correct = item["answer"]["correct"]
        roll = rng.random()
        if roll < blank:
            choice = None
        elif roll < blank + right:
            choice = correct
        else:
            choice = rng.choice([i for i in range(len(item["body"]["options"])) if i != correct])
        answers.append({"question_id": str(item["question_id"]), "choice": choice})
        score += choice == correct
    queries.insert_submission(assessment_id=assessment_id, email=email, answers=answers, score=score,
                              total=len(answers))
    with pool.connection() as conn:
        conn.execute("UPDATE submissions SET submitted_at = %s WHERE assessment_id = %s AND student_email = %s",
                     (NOW - timedelta(days=days_ago), assessment_id, email))
        conn.commit()


def answers_pdf(lines: list[str]) -> bytes:
    """A small valid one-page PDF with `lines` of text (a stand-in scan)."""
    text = "BT /F1 13 Tf 60 780 Td 18 TL " + " ".join(
        "(" + line.replace("\\", "").replace("(", "[").replace(")", "]") + ") '" for line in lines
    ) + " ET"
    objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R "
        "/Resources << /Font << /F1 5 0 R >> >> >>",
        f"<< /Length {len(text)} >>\nstream\n{text}\nendstream",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out, offsets = b"%PDF-1.4\n", []
    for n, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{n} 0 obj\n{body}\nendobj\n".encode()
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    out += "".join(f"{o:010d} 00000 n \n" for o in offsets).encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return out


def hand_in(assessment_id: UUID | None, email: str, *, days_ago: float, by: str | None = None) -> None:
    """Hands in an assignment: the student's PDF of answers, or (`by`) a
    paper copy ticked off by that faculty member."""
    if assessment_id is None:
        return
    if by:
        queries.insert_submission(assessment_id=assessment_id, email=email, answers=[], score=None, total=None,
                                  marked_by=by)
    else:
        a = queries.get_student_assessment(assessment_id, email)
        lines = [f"{a['title']}", f"Answers by {name(email)} ({email})", ""]
        for item in a["items"]:
            lines += [f"Q{item['position']}. {item['body']['prompt'][:80]}", "    (handwritten answer, scanned)", ""]
        data = answers_pdf(lines)
        path = save_handin_file(data)
        queries.save_file_submission(assessment_id=assessment_id, email=email, file_path=str(path),
                                     file_name=f"{email.split('@')[0]}-answers.pdf", file_size=len(data))
    with pool.connection() as conn:
        conn.execute("UPDATE submissions SET submitted_at = %s WHERE assessment_id = %s AND student_email = %s",
                     (NOW - timedelta(days=days_ago), assessment_id, email))
        conn.commit()


def seed_assignments(ctx: dict) -> None:
    """Written assignments (checked on paper; the app records hand-ins)."""
    os_ = "Operating Systems"
    a1 = make_assessment("os_d1", ctx, title="Assignment 1 - Processes and Scheduling", by=F_KEYUR, due_days=7,
                         kind="assignment", subject=os_, count=6, topics=["Processes", "CPU Scheduling"])
    a_due = make_assessment("os_d1", ctx, title="Assignment 2 - Memory and Deadlocks (overdue)", by=F_AMIT,
                            due_days=-2, kind="assignment", subject=os_, count=4,
                            topics=["Memory Management", "Deadlocks"])
    # Old term: different rule key, so it doesn't use up this term's pool.
    old = make_assessment("os_old", ctx, title="Assignment - Last year's OS", by=F_KEYUR, due_days=-300,
                          kind="assignment", subject=os_, count=5)
    a2 = make_assessment("dbms_it", ctx, title="Assignment 1 - SQL and Normalization", by=F_PRIYA, due_days=10,
                         kind="assignment", subject="Database Management Systems", count=5,
                         topics=["Relational Model", "Normalization"])

    # Assignment 1: 5 handed in (one ticked off by the teacher), the rest not yet.
    for i, email in enumerate([CO_D1[0], CO_D1[1], S_ISHA, CO_D1[2]]):
        hand_in(a1, email, days_ago=1 + i * 0.3)
    hand_in(a1, CO_D1[3], days_ago=0.1, by=F_KEYUR)
    # Assignment 2 (overdue): on time, late, and ticked off on paper; others missing.
    for email in CO_D1[:4]:
        hand_in(a_due, email, days_ago=3)
    hand_in(a_due, CO_D1[4], days_ago=1)                # late
    hand_in(a_due, CO_D1[5], days_ago=0.5, by=F_AMIT)   # paper copy, ticked off late
    hand_in(old, CO_D1[0], days_ago=301)
    hand_in(a2, IT_A1[0], days_ago=0.6)
    hand_in(a2, IT_A1[1], days_ago=0.2, by=F_PRIYA)


def seed_assessments(ctx: dict) -> None:
    step("Quizzes (multiple choice) and assignments (written)")
    rng = random.Random(7)
    os_ = "Operating Systems"
    d1, d2 = [*CO_D1, S_ISHA], [*CO_D2, S_GHOST]

    q1 = make_assessment("os_d1", ctx, title="Quiz 1 - Processes and Scheduling", by=F_KEYUR, due_days=2,
                         kind="quiz", subject=os_, count=5, topics=["Processes", "CPU Scheduling"], max_overlap=3)
    q2 = make_assessment("os_d1", ctx, title="Quiz 2 - Memory Management (overdue)", by=F_AMIT, due_days=-3,
                         kind="quiz", subject=os_, count=4, topics=["Memory Management"])
    q3 = make_assessment("os_d2", ctx, title="Quiz 1 - Deadlocks", by=F_AMIT, due_days=1,
                         kind="quiz", subject=os_, count=3, topics=["Deadlocks"])
    q4 = make_assessment("os_d2", ctx, title="Practice Quiz - Easy questions (no due date)", by=F_PRIYA,
                         kind="quiz", subject=os_, count=3, difficulties=[1])
    make_assessment("dbms_it", ctx, title="Quiz 1 - DBMS basics", by=F_KEYUR, due_days=0.5,
                    kind="quiz", subject="Database Management Systems", count=4)
    seed_assignments(ctx)

    step("Submissions (quizzes graded like the API does; assignments only handed in)")
    # Quiz 1 (open): about half the class, from perfect to poor.
    submit(q1, CO_D1[0], rng, right=1, days_ago=0.3)
    submit(q1, CO_D1[1], rng, right=0, days_ago=0.3)
    submit(q1, S_ISHA, rng, right=0.6, blank=0.4, days_ago=0.2)
    for email in CO_D1[2:5]:
        submit(q1, email, rng, right=0.75, days_ago=0.3)
    # Quiz 2 (overdue): everyone but two, before the due date; answers now visible.
    for email in d1[:-2]:
        submit(q2, email, rng, right=0.6, days_ago=4)
    # Div 2: a few on Deadlocks; the practice quiz (no due date) shows answers right after submitting.
    for email in d2[:3]:
        submit(q3, email, rng, right=0.5, days_ago=0.4)
    submit(q4, CO_D2[0], rng, right=0.67, days_ago=2)
    queries.update_classroom(ctx["cr"]["os_old"], archived=True)
    with pool.connection() as conn:
        n = conn.execute("SELECT count(*) AS n FROM submissions").fetchone()["n"]
    print(f"   {n} submissions: perfect, zero, blanks, overdue, late, ticked off by faculty, archived class")

    # Joined after Quiz 1 was handed out: shows as a missing student ("add students").
    queries.add_classroom_students(ctx["cr"]["os_d1"], [S_LATE], None)
    print(f"   {S_LATE} joined OS Div 1 after its quizzes (no sets yet)")
    print("   Not created on purpose: OS Div 2 assignment (left for you; pool shared with Div 1),")
    print("   CN (no approved questions), DBMS CO elective (no term)")


# --- Conversations ---------------------------------------------------------


def seed_conversations(d: dict) -> None:
    step("Chat history")

    def ref(*keys):
        return [{"title": d[k]["title"], "doc_id": str(d[k]["id"])} for k in keys]

    chart = {"type": "bar", "title": "Pass percentage by department (2025-26 Odd)",
             "labels": ["CO", "IT", "EC", "ME", "CE"],
             "datasets": [{"label": "Pass %", "data": [92.1, 88.9, 81.7, 78.0, 82.2]}]}
    convos = [
        (CO_D1[0], "Convoy effect in FCFS", True, 2, [
            ("user", "What is the convoy effect?", None, None),
            ("assistant", "The convoy effect happens in FCFS scheduling when short processes wait behind one long "
                          "process [1].", None, ref("os2")),
            ("user", "And how does Round Robin avoid it?", None, None),
            ("assistant", "Round Robin gives each process a time quantum, so a long process can't hold the CPU [1].",
             None, ref("os2")),
        ]),
        (CO_D1[0], None, False, 1, [  # untitled
            ("user", "What is the minimum attendance to sit the exam?", None, None),
            ("assistant", "You need at least 75 percent attendance [1].", None, ref("conduct")),
        ]),
        (CO_D1[0], "Exam timetable", False, 5, [  # cites a since-deleted document
            ("user", "When is the OS mid-sem?", None, None),
            ("assistant", "Operating Systems is on 12 Sept at 10:00 [1].", None, ref("timetable")),
        ]),
        (S_ISHA, "Normalization vs scheduling", False, 3, [
            ("user", "Explain BCNF and also the SJF algorithm.", None, None),
            ("assistant", "BCNF requires every determinant to be a super key [1]. SJF runs the shortest next burst "
                          "first [2].", None, ref("db2", "os2")),
        ]),
        (F_KEYUR, "Department results chart", True, 1, [
            ("user", "Show a bar chart of pass percentage by department.", None, None),
            ("assistant", "CO had the highest pass percentage at 92.1, ME the lowest at 78.0 [1].", chart,
             ref("results")),
        ]),
        (F_KEYUR, "Answer key lookup", False, 4, [
            ("user", "What is the moderation code in the answer key?", None, None),
            ("assistant", "The moderation code is ZEBRA-4471 [1].", None, ref("os_key")),
        ]),
        (S_FARHAN, "No context answer", False, 2, [
            ("user", "What is in Unit 2 of OS?", None, None),
            ("assistant", "I couldn't find that in the documents available to you.", None, []),
        ]),
    ]
    # Long sidebar for scroll / pinning tests.
    for i in range(12):
        convos.append((CO_D1[1], f"Revision question {i + 1}", i == 0, 10 + i, [
            ("user", f"Revision question {i + 1} about processes", None, None),
            ("assistant", "A process is a program in execution [1].", None, ref("os1")),
        ]))

    with pool.connection() as conn:
        for email, title, pinned, days_ago, messages in convos:
            start = NOW - timedelta(days=days_ago)
            cid = conn.execute(
                "INSERT INTO conversations (user_email, title, is_pinned, created_at, updated_at) "
                "VALUES (%s, %s, %s, %s, %s) RETURNING id",
                (email, title, pinned, start, start + timedelta(minutes=len(messages))),
            ).fetchone()["id"]
            for i, (role, content, chart_cfg, sources) in enumerate(messages):
                conn.execute(
                    "INSERT INTO messages (conversation_id, role, content, chart_config, sources, created_at) "
                    "VALUES (%s, %s, %s, %s, %s, %s)",
                    (cid, role, content, Json(chart_cfg) if chart_cfg else None,
                     Json(sources) if sources is not None else None, start + timedelta(minutes=i)),
                )
        conn.commit()
    print(f"   {len(convos)} conversations (pinned, untitled, chart, deleted source, no sources, 12 for diya)")


# --- Summary ---------------------------------------------------------------


def print_links(emails: list[str]) -> None:
    step(f"Magic login links (one-time each, valid {LINK_EXPIRY_MINUTES // 1440} days)")
    for email in emails:
        token = generate_login_token(email, LINK_EXPIRY_MINUTES)
        print(f"   {email:<28} {settings.MAGIC_LINK_BASE_URL}?token={token}")


def print_summary(ctx: dict) -> None:
    step("Join codes")
    for key, cid in ctx["cr"].items():
        c = queries.get_classroom(cid)
        state = "ARCHIVED" if c["archived_at"] else "active"
        print(f"   {c['join_code']}  {state:<8} {c['name']}")

    step("Who to log in as, and what to check")
    for email, what in [
        (F_KEYUR, "owns OS ws, editor in DBMS; personal ws has a private doc; answer key; failed/stuck uploads"),
        (F_PRIYA, "owns DBMS ws, editor in OS; notifications all read"),
        (F_AMIT, "owns CN ws (only draft questions -> 'not enough' errors), editor in OS"),
        (F_NEHA, "only a personal workspace: empty states; sees faculty-only institute docs"),
        (F_RAHUL, "owns an empty shared workspace (can be deleted)"),
        (F_SNEHA, "invited to OS ws, never signed in: first login shows the shared ws"),
        (CO_D1[0], "aarav, OS Div 1 + archived class + DBMS elective; all notices read; chat history"),
        (CO_D1[1], "diya, OS Div 1 + DBMS elective; 12 conversations; one notice read"),
        (CO_D2[0], "kabir, OS Div 2 + CN: sees Unit 1/2 but NOT Memory Mgmt or Div 1's deck"),
        (S_ISHA, "classrooms in two workspaces (OS Div 1, DBMS IT)"),
        (S_LATE, "joined OS Div 1 after quizzes: sees the assignment but not quiz 1/2"),
        (S_MANAV, "only in an archived class: sees institute docs only, no assessments"),
        (S_FARHAN, "in no classroom: join one with a code above"),
        (S_JAY, "student email with no dept/year pattern"),
        (IT_A1[0], "dev, DBMS IT: assignment + quiz due in 12h"),
    ]:
        print(f"   {email:<28} {what}")
    print("\n   Leak checks: no student should ever get the 'OS Mid-Sem Answer Key' (ask for the moderation"
          "\n   code), 'Faculty Appraisal Guidelines', 'OS Unit 4' (archived class only) or Keyur's research draft.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--yes", action="store_true", help="wipe without asking")
    parser.add_argument("--no-pdfs", action="store_true", help="skip ingesting the real PDFs from docs/")
    parser.add_argument("--links", nargs="*", metavar="EMAIL",
                        help="don't seed; just print fresh login links (all seeded users, or the given emails)")
    args = parser.parse_args()
    logging.basicConfig(level=logging.WARNING, format="   %(levelname)s %(name)s: %(message)s")

    pool.open()
    try:
        if args.links is not None:
            print_links(args.links or [*FACULTY, F_SNEHA, *STUDENTS])
            return

        target = settings.DATABASE_URL.rsplit("@", 1)[-1]
        if not args.yes:
            answer = input(f"This DELETES ALL DATA in {target} and every file in {storage_dir().resolve()}.\n"
                           "Type 'wipe' to continue: ")
            if answer.strip() != "wipe":
                print("Aborted.")
                return

        wipe()
        seed_users()
        ctx = seed_workspaces()
        print("   (one 'run_ingestion failed' error below is expected: the corrupt circular)")
        docs = seed_documents(ctx, with_pdfs=not args.no_pdfs)
        seed_notification_reads()
        seed_notes(ctx, docs)
        seed_questions(ctx, docs)
        seed_assessments(ctx)
        seed_conversations(docs)
        print_summary(ctx)
        print_links([*FACULTY, F_SNEHA, *STUDENTS])
        print("\nDone.")
    finally:
        pool.close()


if __name__ == "__main__":
    main()
