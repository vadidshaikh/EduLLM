"""Question bank, quizzes and assignments (Phase 4).

The bank belongs to a workspace: any of its faculty can draft questions
from sources with the LLM (or write them), edit them, and approve them.
Only approved questions are used. A question too close to one already in
the bank is refused, so "different" questions aren't paraphrases.

An assessment belongs to a classroom of that workspace:
- an assignment is one set for the whole class, using no question another
  assignment in the same subject and term already uses (in any classroom);
- a quiz gives each student their own set with the same mix of topics and
  difficulties, no two identical (and, optionally, sharing at most
  `max_overlap` questions).
Which questions go where is plain Python (`app.assessments.assign`) with a
stored seed.

Quizzes are multiple choice: students answer in the app, submit once and
are graded on submit; they see the answers once the due date (if any) has
passed. Assignments are written (short and long answer, up to 25): each
student hands in a PDF of their answers (replaceable; late allowed), which
faculty open from here and check. Faculty can also tick off a paper copy.
Nothing about an assignment is marked in the app.

Like workspaces.py, every check 404s for non-members.
"""
import secrets
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile, status

from app.api.schemas import (
    AssessmentCheckOut,
    AssessmentConfig,
    AssessmentOut,
    AssessmentSummaryOut,
    ClassroomAnalyticsOut,
    CreateAssessmentRequest,
    CreateQuestionRequest,
    GenerateQuestionsRequest,
    GenerateQuestionsResponse,
    QuestionContent,
    QuestionOut,
    SetQuestionsStatusRequest,
    SetQuestionsStatusResponse,
    StudentAssessmentOut,
    StudentAssessmentSummaryOut,
    SubmitAnswersRequest,
    UpdateQuestionRequest,
)
from app.api.workspaces import managed_classroom, member_workspace, require_student
from app.assessments.assign import NotEnoughQuestions, PoolQuestion, assignment_set, quiz_sets
from app.assessments.generate import DUPLICATE_SIMILARITY, clean_question, draft_questions, question_text
from app.auth.dependencies import require_faculty
from app.authoring.generate import GenerationError
from app.db import queries
from app.ingestion.embedder import embed_texts
from app.storage import delete_stored_file, save_handin_file

router = APIRouter()

_MAX_SOURCES = 8
_TYPES = ["mcq", "short", "long"]
# What each kind of assessment is made of.
_POOL_TYPES = {"quiz": ["mcq"], "assignment": ["short", "long"]}
_MAX_ASSIGNMENT_QUESTIONS = 25
_MAX_HANDIN_BYTES = 20 * 1024 * 1024


def _unprocessable(detail: str) -> HTTPException:
    return HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail)


def _required_text(value: str | None, field: str) -> str:
    value = (value or "").strip()
    if not value:
        raise _unprocessable(f"{field} cannot be empty")
    return value


def _question(question_id: UUID, claims: dict) -> dict:
    """The question if the caller is faculty in its workspace, otherwise 404."""
    question = queries.get_question(question_id)
    if question is None or queries.get_member_workspace(question["workspace_id"], claims["sub"]) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "question not found")
    return question


def _content(content: QuestionContent) -> dict:
    """A written or edited question, checked like the model's drafts."""
    question = clean_question(content.model_dump(), types=_TYPES)
    if question is None:
        if not content.prompt.strip():
            raise _unprocessable("the question cannot be empty")
        raise _unprocessable("a multiple-choice question needs at least 2 different options and one marked correct")
    return question


def _refuse_duplicate(workspace_id: UUID, embedding: list[float], exclude_id: UUID | None = None) -> None:
    similar = queries.most_similar_question(workspace_id, embedding, exclude_id=exclude_id)
    if similar is not None and similar["similarity"] > DUPLICATE_SIMILARITY:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f'too close to a question already in the bank: "{similar["prompt"][:160]}"',
        )


# --- Question bank (faculty) ---


@router.get("/workspaces/{workspace_id}/questions", response_model=list[QuestionOut])
def list_questions(workspace_id: UUID, claims: dict = Depends(require_faculty)) -> list[QuestionOut]:
    member_workspace(workspace_id, claims)
    return queries.list_questions(workspace_id)


@router.post("/workspaces/{workspace_id}/questions/generate", response_model=GenerateQuestionsResponse)
def generate_questions(
    workspace_id: UUID, body: GenerateQuestionsRequest, claims: dict = Depends(require_faculty)
) -> GenerateQuestionsResponse:
    """Has the LLM draft questions from the chosen sources (this
    workspace's documents). It labels each one's topic and picks its subject
    from the workspace's. They're saved as drafts for review; near-duplicates
    of the bank are dropped.
    """
    member_workspace(workspace_id, claims)
    types = list(dict.fromkeys(body.types))
    if not types:
        raise _unprocessable("pick a question type")
    difficulties = sorted({d for d in body.difficulties if d in (1, 2, 3)})
    if not difficulties:
        raise _unprocessable("pick at least one difficulty")

    source_ids = list(dict.fromkeys(body.source_doc_ids))
    if not source_ids or len(source_ids) > _MAX_SOURCES:
        raise _unprocessable(f"pick 1 to {_MAX_SOURCES} source documents")
    allowed = {d["id"]: d for d in queries.list_note_source_documents(workspace_id) if d["workspace_id"]}
    if not set(source_ids) <= allowed.keys():
        raise _unprocessable("sources must be ready documents in this workspace")
    sources = [{"doc_id": str(i), "title": allowed[i]["title"]} for i in source_ids]

    try:
        drafts, duplicates = draft_questions(
            claims,
            workspace_id=workspace_id,
            sources=sources,
            count=body.count,
            types=types,
            difficulties=difficulties,
            instructions=(body.instructions or "").strip() or None,
        )
    except GenerationError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Couldn't write questions: {exc}") from exc

    ids = queries.insert_questions(workspace_id=workspace_id, questions=drafts, actor_email=claims["sub"])
    return GenerateQuestionsResponse(questions=[queries.get_question(i) for i in ids], duplicates=duplicates)


@router.post("/workspaces/{workspace_id}/questions", response_model=QuestionOut, status_code=status.HTTP_201_CREATED)
def create_question(workspace_id: UUID, body: CreateQuestionRequest, claims: dict = Depends(require_faculty)) -> QuestionOut:
    """Adds a hand-written question (as a draft). 409 if the bank already
    has one too close to it.
    """
    member_workspace(workspace_id, claims)
    question = _content(body)
    question["subject"] = _required_text(body.subject, "subject")
    question["topic"] = _required_text(body.topic, "topic")
    question["embedding"] = embed_texts([question_text(question["body"])])[0]
    _refuse_duplicate(workspace_id, question["embedding"])
    [question_id] = queries.insert_questions(
        workspace_id=workspace_id, questions=[question], actor_email=claims["sub"]
    )
    return queries.get_question(question_id)


@router.patch("/questions/{question_id}", response_model=QuestionOut)
def update_question(question_id: UUID, body: UpdateQuestionRequest, claims: dict = Depends(require_faculty)) -> QuestionOut:
    """Edits a question and/or approves it. Edits apply to assessments that
    already use it too (fix a typo once); 409 if the new wording is too
    close to another question in the bank.
    """
    question = _question(question_id, claims)
    changes: dict = {}
    if body.subject is not None:
        changes["subject"] = _required_text(body.subject, "subject")
    if body.topic is not None:
        changes["topic"] = _required_text(body.topic, "topic")
    if body.status is not None:
        changes["status"] = body.status
    if body.content is not None:
        content = _content(body.content)
        # Sets store their shuffled option order, so a question in use keeps
        # its type and number of options.
        option_count = len(content["body"].get("options", []))
        if question["use_count"] and (
            content["type"] != question["type"] or option_count != len(question["body"].get("options", []))
        ):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "this question is in a quiz or assignment, so its type and number of options can't change",
            )
        if content["body"] != question["body"]:
            content["embedding"] = embed_texts([question_text(content["body"])])[0]
            _refuse_duplicate(question["workspace_id"], content["embedding"], exclude_id=question_id)
        changes.update(content)
    if not changes:
        raise _unprocessable("no fields to update")
    queries.update_question(question_id, changes, actor_email=claims["sub"])
    return queries.get_question(question_id)


@router.post("/workspaces/{workspace_id}/questions/status", response_model=SetQuestionsStatusResponse)
def set_questions_status(
    workspace_id: UUID, body: SetQuestionsStatusRequest, claims: dict = Depends(require_faculty)
) -> SetQuestionsStatusResponse:
    """Approves (or returns to draft) several questions at once."""
    member_workspace(workspace_id, claims)
    changed = queries.set_questions_status(workspace_id, body.question_ids, body.status, actor_email=claims["sub"])
    return SetQuestionsStatusResponse(changed=changed)


@router.delete("/questions/{question_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_question(question_id: UUID, claims: dict = Depends(require_faculty)) -> None:
    """Deletes a question unless a quiz or assignment uses it (delete those first)."""
    _question(question_id, claims)
    if not queries.delete_question(question_id):
        raise HTTPException(status.HTTP_409_CONFLICT, "this question is used in a quiz or assignment; delete that first")


# --- Quizzes and assignments (faculty) ---


def _plan(classroom: dict, config: AssessmentConfig) -> dict:
    """Works out an assessment for the classroom without saving it:
    {ok, message, subject, available, needed, students, sharing, key, sets}.
    `sets` maps email (None = class-wide) to items when ok.
    """
    subject = (config.subject or classroom["subject"] or "").strip()
    roster = [s["email"] for s in queries.list_classroom_students(classroom["id"])]
    result = {"subject": subject or None, "students": len(roster), "sharing": [], "needed": None, "sets": {}}
    if not subject:
        return {**result, "ok": False, "available": 0, "message": "set a subject (or give the classroom one)"}
    if config.kind == "assignment" and config.count > _MAX_ASSIGNMENT_QUESTIONS:
        return {**result, "ok": False, "available": 0,
                "message": f"an assignment can have at most {_MAX_ASSIGNMENT_QUESTIONS} questions"}

    key = queries.rule_key(subject, classroom["term"])
    result["key"] = key
    pool_rows = queries.approved_pool(
        classroom["workspace_id"],
        subject=subject,
        topics=config.topics,
        types=_POOL_TYPES[config.kind],
        difficulties=config.difficulties,
        doc_ids=config.source_doc_ids,
        unused_by_assignments=key if config.kind == "assignment" else None,
    )
    pool = [PoolQuestion(str(r["id"]), r["topic"], r["difficulty"], r["option_count"]) for r in pool_rows]
    result["available"] = len(pool)
    seed = secrets.randbits(62)
    result["seed"] = seed

    try:
        if config.kind == "assignment":
            sharing = queries.classrooms_sharing_rule(classroom["workspace_id"], key)
            result["sharing"] = sharing
            result["sets"] = {None: assignment_set(pool, config.count, seed)}
            waiting = [c for c in sharing if not c["has_assignment"] and c["id"] != classroom["id"]]
            message = f"{len(pool)} unused question{'s' if len(pool) != 1 else ''} for {subject} this term."
            if waiting and len(pool) - config.count < config.count * len(waiting):
                message += (
                    f" After this, {len(pool) - config.count} are left for "
                    f"{len(waiting)} other classroom{'s' if len(waiting) != 1 else ''} with the same subject and term."
                )
        else:
            if not roster:
                return {**result, "ok": False, "message": "the classroom has no students yet"}
            result["sets"] = quiz_sets(pool, config.count, roster, seed, max_overlap=config.max_overlap)
            message = f"{len(roster)} students, each with a different set of {config.count} from {len(pool)} questions."
    except NotEnoughQuestions as exc:
        message = str(exc).capitalize()
        if config.kind == "assignment":
            message = (
                f"Only {len(pool)} matching approved written {subject} question{'s' if len(pool) != 1 else ''} "
                f"aren't used by another assignment this term; this one needs {config.count}."
            )
        return {**result, "ok": False, "message": message, "needed": exc.needed, "sets": {}}
    return {**result, "ok": True, "message": message}


def _assessment(assessment_id: UUID, claims: dict) -> tuple[dict, dict]:
    """The assessment and its classroom if the caller is faculty in the
    classroom's workspace, otherwise 404.
    """
    assessment = queries.get_assessment(assessment_id)
    if assessment is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "assessment not found")
    try:
        classroom = managed_classroom(assessment["classroom_id"], claims)
    except HTTPException as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "assessment not found") from exc
    return assessment, classroom


def _shown(item: dict) -> tuple[list[str], int | None]:
    """An item's options in the order its set shows them, and the shown
    index of the correct one.
    """
    options = item["body"].get("options", [])
    order = item["option_order"] or list(range(len(options)))
    shown = [options[i] for i in order if i < len(options)]
    correct = item["answer"].get("correct") if "answer" in item else None
    return shown, order.index(correct) if correct is not None and correct in order else None


def _full_assessment(assessment: dict, classroom: dict) -> dict:
    sets: dict = {}
    for item in queries.get_assessment_items(assessment["id"]):
        entry = sets.setdefault(
            item["student_email"],
            {"student_email": item["student_email"], "student_name": item["student_name"], "items": []},
        )
        options, correct = _shown(item)
        entry["items"].append(
            {
                "position": item["position"],
                "question_id": item["question_id"],
                "topic": item["topic"],
                "type": item["type"],
                "difficulty": item["difficulty"],
                "prompt": item["body"]["prompt"],
                "options": options,
                "correct": correct,
                "explanation": item["answer"].get("explanation", ""),
                "option_order": item["option_order"],
                "source_doc_ids": item["source_doc_ids"],
            }
        )
    roster = queries.list_classroom_students(classroom["id"])
    missing = []
    if assessment["kind"] == "quiz":
        missing = [s["email"] for s in roster if s["email"] not in sets]
    return {
        **assessment,
        "sets": list(sets.values()),
        "missing_students": missing,
        "results": _results(assessment, sets, roster),
    }


def _results(assessment: dict, sets: dict, roster: list[dict]) -> list[dict]:
    """Marks per student, by name: quiz students with a set, or an
    assignment's classroom; plus anyone who submitted and since left.
    `choices` maps each position to the option they picked as shown.
    """
    submissions = {s["student_email"]: s for s in queries.list_submissions(assessment["id"])}
    if assessment["kind"] == "quiz":
        people = {e: s["student_name"] for e, s in sets.items()}
    else:
        people = {s["email"]: s["name"] for s in roster}
    for email, sub in submissions.items():
        people.setdefault(email, sub["student_name"])

    results = []
    for email, name in people.items():
        sub = submissions.get(email)
        choices = {}
        if sub is not None and assessment["kind"] == "quiz":
            picked = {a["question_id"]: a["choice"] for a in sub["answers"]}
            for item in (sets.get(email) or sets.get(None) or {"items": []})["items"]:
                choice = picked.get(str(item["question_id"]))
                choices[item["position"]] = _shown_index(item["option_order"], choice)
        results.append(
            {
                "student_email": email,
                "student_name": name,
                "score": sub["score"] if sub else None,
                "total": sub["total"] if sub else None,
                "submitted_at": sub["submitted_at"] if sub else None,
                "late": bool(sub and assessment["due_at"] and sub["submitted_at"] > assessment["due_at"]),
                "marked_by": sub["marked_by"] if sub else None,
                "file_name": sub["file_name"] if sub else None,
                "file_size": sub["file_size"] if sub else None,
                "choices": choices,
            }
        )
    return sorted(results, key=lambda r: (r["student_name"] or r["student_email"]).lower())


def _shown_index(option_order: list[int] | None, choice: int | None) -> int | None:
    """Where the option stored as `choice` sits in the order a set shows."""
    if choice is None:
        return None
    order = option_order or []
    return order.index(choice) if choice in order else choice


@router.get("/classrooms/{classroom_id}/assessments", response_model=list[AssessmentSummaryOut])
def list_assessments(classroom_id: UUID, claims: dict = Depends(require_faculty)) -> list[AssessmentSummaryOut]:
    managed_classroom(classroom_id, claims)
    return queries.list_assessments(classroom_id)


@router.get("/classrooms/{classroom_id}/analytics", response_model=ClassroomAnalyticsOut)
def classroom_analytics(classroom_id: UUID, claims: dict = Depends(require_faculty)) -> ClassroomAnalyticsOut:
    """How a classroom is doing across its quizzes and assignments: each
    assessment's turnout and average, each student's record, how well each
    chapter (source doc) is understood, and the questions most got wrong.
    Quiz marks only; assignments are marked on paper, so they count as
    handed in or not.
    """
    classroom = managed_classroom(classroom_id, claims)
    roster = queries.list_classroom_students(classroom_id)
    students = {
        s["email"]: {"email": s["email"], "name": s["name"], "quiz_scores": [], "quizzes": 0,
                     "assignments": 0, "handed_in": 0, "missed": 0, "late": 0}
        for s in roster
    }
    now = datetime.now(timezone.utc)
    assessments, chapters, questions = [], {}, {}

    for summary in queries.list_assessments(classroom_id):
        full = _full_assessment(summary, classroom)
        is_quiz = full["kind"] == "quiz"
        overdue = full["due_at"] is not None and full["due_at"] <= now
        sets = {s["student_email"]: s for s in full["sets"]}
        done, percents, late = 0, [], 0
        for r in full["results"]:
            person = students.get(r["student_email"])
            submitted = r["submitted_at"] is not None
            done += submitted
            late += r["late"]
            if is_quiz and r["score"] is not None and r["total"]:
                percents.append(r["score"] / r["total"])
            if person is None:
                continue  # left the classroom since
            person["quizzes" if is_quiz else "assignments"] += 1
            if submitted:
                person["handed_in"] += 1
                person["late"] += r["late"]
                if is_quiz and r["score"] is not None and r["total"]:
                    person["quiz_scores"].append(r["score"] / r["total"])
            elif overdue:
                person["missed"] += 1

            if not (is_quiz and submitted):
                continue
            for item in (sets.get(r["student_email"]) or {"items": []})["items"]:
                right = r["choices"].get(item["position"]) == item["correct"]
                q = questions.setdefault(
                    item["question_id"],
                    {"question_id": item["question_id"], "prompt": item["prompt"], "assessment": full["title"],
                     "answered": 0, "right": 0},
                )
                q["answered"] += 1
                q["right"] += right
                for doc_id in item["source_doc_ids"] or [None]:
                    c = chapters.setdefault(doc_id, {"doc_id": doc_id, "answered": 0, "right": 0})
                    c["answered"] += 1
                    c["right"] += right

        assessments.append({
            "id": full["id"], "kind": full["kind"], "title": full["title"], "due_at": full["due_at"],
            "created_at": full["created_at"], "assigned": len(full["results"]), "submitted": done, "late": late,
            "average": sum(percents) / len(percents) if percents else None,
        })

    titles = {d["id"]: d["title"] for d in queries.get_documents([d for d in chapters if d is not None])}
    chapter_rows = sorted(
        ({**c, "title": titles.get(c["doc_id"], "Written by hand" if c["doc_id"] is None else "A removed doc"),
          "accuracy": c["right"] / c["answered"]} for c in chapters.values()),
        key=lambda c: c["accuracy"],
    )
    hardest = sorted(
        ({**q, "accuracy": q["right"] / q["answered"]} for q in questions.values() if q["answered"] >= 2),
        key=lambda q: (q["accuracy"], -q["answered"]),
    )[:5]
    student_rows = [
        {**{k: v for k, v in s.items() if k != "quiz_scores"},
         "average": sum(s["quiz_scores"]) / len(s["quiz_scores"]) if s["quiz_scores"] else None}
        for s in students.values()
    ]
    all_scores = [p for s in students.values() for p in s["quiz_scores"]]
    given = sum(a["assigned"] for a in assessments)
    return ClassroomAnalyticsOut(
        students=len(roster),
        quizzes=sum(a["kind"] == "quiz" for a in assessments),
        assignments=sum(a["kind"] == "assignment" for a in assessments),
        average=sum(all_scores) / len(all_scores) if all_scores else None,
        completion=sum(a["submitted"] for a in assessments) / given if given else None,
        assessments=assessments,
        student_rows=sorted(student_rows, key=lambda s: (s["name"] or s["email"]).lower()),
        chapters=chapter_rows,
        hardest=hardest,
    )


@router.post("/classrooms/{classroom_id}/assessments/check", response_model=AssessmentCheckOut)
def check_assessment(
    classroom_id: UUID, body: AssessmentConfig, claims: dict = Depends(require_faculty)
) -> AssessmentCheckOut:
    """Whether the bank has enough questions for this quiz or assignment,
    and how many would be, without creating anything.
    """
    plan = _plan(managed_classroom(classroom_id, claims), body)
    return AssessmentCheckOut(**plan)


@router.post("/classrooms/{classroom_id}/assessments", response_model=AssessmentOut, status_code=status.HTTP_201_CREATED)
def create_assessment(
    classroom_id: UUID, body: CreateAssessmentRequest, claims: dict = Depends(require_faculty)
) -> AssessmentOut:
    """Creates a quiz (a set per student in the classroom now) or an
    assignment (one set for the class). 422 if the bank can't supply it.
    """
    classroom = managed_classroom(classroom_id, claims)
    if classroom["archived_at"] is not None:
        raise _unprocessable("this classroom is archived")
    title = _required_text(body.title, "title")
    plan = _plan(classroom, body)
    if not plan["ok"]:
        raise _unprocessable(plan["message"])
    config = body.model_dump(mode="json", include={"count", "source_doc_ids", "topics", "difficulties", "max_overlap"})
    config["types"] = _POOL_TYPES[body.kind]
    if body.kind == "assignment":
        config["max_overlap"] = None
    assessment_id = queries.insert_assessment(
        classroom_id=classroom_id,
        kind=body.kind,
        title=title,
        subject=plan["subject"],
        key=plan["key"],
        config=config,
        seed=plan["seed"],
        due_at=body.due_at,
        actor_email=claims["sub"],
        sets=plan["sets"],
    )
    if assessment_id is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "another assignment took some of these questions just now; try again",
        )
    assessment, classroom = _assessment(assessment_id, claims)
    return _full_assessment(assessment, classroom)


@router.get("/assessments/{assessment_id}", response_model=AssessmentOut)
def get_assessment(assessment_id: UUID, claims: dict = Depends(require_faculty)) -> AssessmentOut:
    """The assessment with every set and its answers."""
    return _full_assessment(*_assessment(assessment_id, claims))


@router.post("/assessments/{assessment_id}/add-students", response_model=AssessmentOut)
def add_quiz_students(assessment_id: UUID, claims: dict = Depends(require_faculty)) -> AssessmentOut:
    """Gives a quiz set to the classroom's students who joined after it was
    made, following the same rules against the sets already handed out.
    """
    assessment, classroom = _assessment(assessment_id, claims)
    if assessment["kind"] != "quiz":
        raise _unprocessable("only quizzes have a set per student")
    current = _full_assessment(assessment, classroom)
    if not current["missing_students"]:
        return current

    config = assessment["config"]
    pool_rows = queries.approved_pool(
        classroom["workspace_id"],
        subject=assessment["subject"],
        topics=config["topics"],
        types=_POOL_TYPES["quiz"],
        difficulties=config["difficulties"],
        doc_ids=[UUID(d) for d in config.get("source_doc_ids", [])],
    )
    pool = [PoolQuestion(str(r["id"]), r["topic"], r["difficulty"], r["option_count"]) for r in pool_rows]
    existing = [[str(i["question_id"]) for i in s["items"]] for s in current["sets"]]
    try:
        sets = quiz_sets(
            pool,
            config["count"],
            current["missing_students"],
            assessment["seed"],
            max_overlap=config["max_overlap"],
            existing=existing,
        )
    except NotEnoughQuestions as exc:
        raise _unprocessable(str(exc).capitalize()) from exc
    if not queries.add_assessment_sets(assessment_id, sets):
        raise HTTPException(status.HTTP_409_CONFLICT, "someone else just did this; reload")
    return _full_assessment(*_assessment(assessment_id, claims))


@router.put("/assessments/{assessment_id}/submissions/{email}", response_model=AssessmentOut)
def mark_handed_in(assessment_id: UUID, email: str, claims: dict = Depends(require_faculty)) -> AssessmentOut:
    """Ticks off an assignment handed in on paper for a classroom student."""
    assessment, classroom = _assessment(assessment_id, claims)
    if assessment["kind"] != "assignment":
        raise _unprocessable("quizzes are submitted by students in the app")
    email = email.strip().lower()
    if email not in {s["email"] for s in queries.list_classroom_students(classroom["id"])}:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not a student in this classroom")
    queries.insert_submission(
        assessment_id=assessment_id, email=email, answers=[], score=None, total=None, marked_by=claims["sub"]
    )  # already handed in: nothing to do
    return _full_assessment(assessment, classroom)


@router.delete("/assessments/{assessment_id}/submissions/{email}", response_model=AssessmentOut)
def unmark_handed_in(assessment_id: UUID, email: str, claims: dict = Depends(require_faculty)) -> AssessmentOut:
    """Undoes an assignment hand-in (ticked off by mistake). Quiz
    submissions are graded answers and can't be undone.
    """
    assessment, classroom = _assessment(assessment_id, claims)
    if assessment["kind"] != "assignment":
        raise _unprocessable("quiz submissions can't be undone")
    removed = queries.delete_submission(assessment_id, email.strip().lower())
    if removed and removed["file_path"]:
        delete_stored_file(removed["file_path"])
    return _full_assessment(assessment, classroom)


def _pdf_response(submission: dict | None) -> Response:
    if submission is None or not submission["file_path"]:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no PDF handed in")
    try:
        with open(submission["file_path"], "rb") as f:
            data = f.read()
    except FileNotFoundError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "the file is missing") from exc
    name = submission["file_name"].replace('"', "")
    return Response(data, media_type="application/pdf", headers={"Content-Disposition": f'inline; filename="{name}"'})


@router.get("/assessments/{assessment_id}/submissions/{email}/file")
def get_handed_in_file(assessment_id: UUID, email: str, claims: dict = Depends(require_faculty)) -> Response:
    """A student's handed-in PDF, for faculty of the classroom's workspace."""
    _assessment(assessment_id, claims)
    return _pdf_response(queries.get_submission(assessment_id, email.strip().lower()))


@router.delete("/assessments/{assessment_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_assessment(assessment_id: UUID, claims: dict = Depends(require_faculty)) -> None:
    """Deletes it for everyone; an assignment's questions become free for
    other classrooms again.
    """
    _assessment(assessment_id, claims)
    for path in queries.delete_assessment(assessment_id):
        delete_stored_file(path)


# --- Student side ---


@router.get("/my/assessments", response_model=list[StudentAssessmentSummaryOut])
def list_my_assessments(claims: dict = Depends(require_student)) -> list[StudentAssessmentSummaryOut]:
    return queries.list_student_assessments(claims["sub"])


def _due_passed(assessment: dict) -> bool:
    return assessment["due_at"] is not None and assessment["due_at"] <= datetime.now(tz=timezone.utc)


@router.get("/my/assessments/{assessment_id}", response_model=StudentAssessmentOut)
def get_my_assessment(assessment_id: UUID, claims: dict = Depends(require_student)) -> StudentAssessmentOut:
    """The caller's own questions, in their order. After they've submitted:
    their picks and marks, and (once any due date has passed) the answers.
    """
    assessment = queries.get_student_assessment(assessment_id, claims["sub"], with_answers=True)
    if assessment is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not found")
    submission = queries.get_submission(assessment_id, claims["sub"])
    is_quiz = assessment["kind"] == "quiz"
    # An assignment's model answers stay with faculty: it's checked on paper.
    visible = is_quiz and submission is not None and (assessment["due_at"] is None or _due_passed(assessment))
    picked = {a["question_id"]: a["choice"] for a in submission["answers"]} if submission else {}
    items = []
    for item in assessment.pop("items"):
        options, correct = _shown(item)
        out = {"position": item["position"], "type": item["type"], "prompt": item["body"]["prompt"], "options": options}
        if submission is not None and is_quiz:
            out["choice"] = _shown_index(item["option_order"], picked.get(str(item["question_id"])))
            out["is_right"] = out["choice"] is not None and out["choice"] == correct
        if visible:
            out["correct"] = correct
            out["explanation"] = item["answer"].get("explanation", "")
        items.append(out)
    return StudentAssessmentOut(
        **assessment,
        question_count=len(items),
        items=items,
        score=submission["score"] if submission else None,
        total=submission["total"] if submission else None,
        submitted_at=submission["submitted_at"] if submission else None,
        closed=is_quiz and submission is None and _due_passed(assessment),
        file_name=submission["file_name"] if submission else None,
        file_size=submission["file_size"] if submission else None,
        results_visible=visible,
    )


@router.post("/my/assessments/{assessment_id}/submit", response_model=StudentAssessmentOut)
def submit_my_assessment(
    assessment_id: UUID, body: SubmitAnswersRequest, claims: dict = Depends(require_student)
) -> StudentAssessmentOut:
    """Grades and saves the caller's quiz answers (once; 409 if already
    submitted, 422 once the due date has passed). Each answer is an option
    index as the student's set shows it. Assignments are handed in with
    `hand_in_assignment` instead.
    """
    assessment = queries.get_student_assessment(assessment_id, claims["sub"], with_answers=True)
    if assessment is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not found")
    if assessment["kind"] == "assignment":
        raise _unprocessable("hand in an assignment by uploading your answers as a PDF")
    if _due_passed(assessment):
        raise _unprocessable("the due date has passed")
    given = {a.position: a.choice for a in body.answers}
    answers, score, total = [], 0, 0
    for item in assessment["items"]:
        if item["type"] != "mcq":
            continue  # older written questions aren't graded here
        options, correct = _shown(item)
        shown = given.get(item["position"])
        if shown is not None and not 0 <= shown < len(options):
            raise _unprocessable(f"question {item['position']} has no option {shown + 1}")
        order = item["option_order"] or list(range(len(options)))
        choice = order[shown] if shown is not None else None
        answers.append({"question_id": str(item["question_id"]), "choice": choice})
        total += 1
        score += shown is not None and shown == correct
    if not queries.insert_submission(
        assessment_id=assessment_id, email=claims["sub"], answers=answers, score=score, total=total
    ):
        raise HTTPException(status.HTTP_409_CONFLICT, "you've already submitted this")
    return get_my_assessment(assessment_id, claims)


@router.post("/my/assessments/{assessment_id}/hand-in", response_model=StudentAssessmentOut)
async def hand_in_assignment(
    assessment_id: UUID, file: UploadFile = File(...), claims: dict = Depends(require_student)
) -> StudentAssessmentOut:
    """Hands in the caller's assignment as a PDF (up to 20 MB), replacing
    one they handed in before. Late hand-ins are allowed and show as late.
    """
    assessment = queries.get_student_assessment(assessment_id, claims["sub"])
    if assessment is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not found")
    if assessment["kind"] != "assignment":
        raise _unprocessable("quizzes are answered in the app")
    data = await file.read(_MAX_HANDIN_BYTES + 1)
    if len(data) > _MAX_HANDIN_BYTES:
        raise _unprocessable("the PDF is over 20 MB; scan at a lower resolution")
    if not data.startswith(b"%PDF"):
        raise _unprocessable("that isn't a PDF; export or scan your answers to PDF")
    name = (file.filename or "answers.pdf").strip()[:120] or "answers.pdf"
    path = save_handin_file(data)
    replaced = queries.save_file_submission(
        assessment_id=assessment_id, email=claims["sub"], file_path=str(path), file_name=name, file_size=len(data)
    )
    if replaced:
        delete_stored_file(replaced)
    return get_my_assessment(assessment_id, claims)


@router.get("/my/assessments/{assessment_id}/hand-in")
def get_my_handed_in_file(assessment_id: UUID, claims: dict = Depends(require_student)) -> Response:
    """The caller's own handed-in PDF."""
    if queries.get_student_assessment(assessment_id, claims["sub"]) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not found")
    return _pdf_response(queries.get_submission(assessment_id, claims["sub"]))
