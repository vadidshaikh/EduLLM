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
stored seed. Students see their own questions, never the answers.

Like workspaces.py, every check 404s for non-members.
"""
import secrets
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.schemas import (
    AssessmentCheckOut,
    AssessmentConfig,
    AssessmentOut,
    AssessmentSummaryOut,
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
    UpdateQuestionRequest,
)
from app.api.workspaces import managed_classroom, member_workspace, require_student
from app.assessments.assign import NotEnoughQuestions, PoolQuestion, assignment_set, quiz_sets
from app.assessments.generate import DUPLICATE_SIMILARITY, clean_question, draft_questions, question_text
from app.auth.dependencies import require_faculty
from app.authoring.generate import GenerationError
from app.db import queries
from app.ingestion.embedder import embed_texts

router = APIRouter()

_MAX_SOURCES = 8
_TYPES = ["mcq", "short", "long"]


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
    """Has the LLM draft questions on a topic from the chosen sources (this
    workspace's documents and the institute library's). They're saved as
    drafts for review; near-duplicates of the bank are dropped.
    """
    member_workspace(workspace_id, claims)
    subject = _required_text(body.subject, "subject")
    topic = _required_text(body.topic, "topic")
    types = list(dict.fromkeys(body.types))
    difficulties = sorted({d for d in body.difficulties if d in (1, 2, 3)})
    if not types or not difficulties:
        raise _unprocessable("pick at least one question type and difficulty")

    source_ids = list(dict.fromkeys(body.source_doc_ids))
    if not source_ids or len(source_ids) > _MAX_SOURCES:
        raise _unprocessable(f"pick 1 to {_MAX_SOURCES} source documents")
    allowed = {d["id"]: d for d in queries.list_note_source_documents(workspace_id)}
    if not set(source_ids) <= allowed.keys():
        raise _unprocessable("sources must be ready documents in this workspace or the institute library")
    sources = [{"doc_id": str(i), "title": allowed[i]["title"]} for i in source_ids]

    try:
        drafts, duplicates = draft_questions(
            claims,
            workspace_id=workspace_id,
            subject=subject,
            topic=topic,
            sources=sources,
            count=body.count,
            types=types,
            difficulties=difficulties,
            instructions=(body.instructions or "").strip() or None,
        )
    except GenerationError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Couldn't write questions: {exc}") from exc

    ids = queries.insert_questions(
        workspace_id=workspace_id, subject=subject, topic=topic, questions=drafts, actor_email=claims["sub"]
    )
    return GenerateQuestionsResponse(questions=[queries.get_question(i) for i in ids], duplicates=duplicates)


@router.post("/workspaces/{workspace_id}/questions", response_model=QuestionOut, status_code=status.HTTP_201_CREATED)
def create_question(workspace_id: UUID, body: CreateQuestionRequest, claims: dict = Depends(require_faculty)) -> QuestionOut:
    """Adds a hand-written question (as a draft). 409 if the bank already
    has one too close to it.
    """
    member_workspace(workspace_id, claims)
    question = _content(body)
    question["embedding"] = embed_texts([question_text(question["body"])])[0]
    _refuse_duplicate(workspace_id, question["embedding"])
    [question_id] = queries.insert_questions(
        workspace_id=workspace_id,
        subject=_required_text(body.subject, "subject"),
        topic=_required_text(body.topic, "topic"),
        questions=[question],
        actor_email=claims["sub"],
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

    key = queries.rule_key(subject, classroom["term"])
    result["key"] = key
    pool_rows = queries.approved_pool(
        classroom["workspace_id"],
        subject=subject,
        topics=config.topics,
        types=config.types,
        difficulties=config.difficulties,
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
                f"Only {len(pool)} matching approved {subject} question{'s' if len(pool) != 1 else ''} "
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
            }
        )
    missing = []
    if assessment["kind"] == "quiz":
        roster = [s["email"] for s in queries.list_classroom_students(classroom["id"])]
        missing = [e for e in roster if e not in sets]
    return {**assessment, "sets": list(sets.values()), "missing_students": missing}


@router.get("/classrooms/{classroom_id}/assessments", response_model=list[AssessmentSummaryOut])
def list_assessments(classroom_id: UUID, claims: dict = Depends(require_faculty)) -> list[AssessmentSummaryOut]:
    managed_classroom(classroom_id, claims)
    return queries.list_assessments(classroom_id)


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
    config = body.model_dump(include={"count", "topics", "types", "difficulties", "max_overlap"})
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
        types=config["types"],
        difficulties=config["difficulties"],
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


@router.delete("/assessments/{assessment_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_assessment(assessment_id: UUID, claims: dict = Depends(require_faculty)) -> None:
    """Deletes it for everyone; an assignment's questions become free for
    other classrooms again.
    """
    _assessment(assessment_id, claims)
    queries.delete_assessment(assessment_id)


# --- Student side ---


@router.get("/my/assessments", response_model=list[StudentAssessmentSummaryOut])
def list_my_assessments(claims: dict = Depends(require_student)) -> list[StudentAssessmentSummaryOut]:
    return queries.list_student_assessments(claims["sub"])


@router.get("/my/assessments/{assessment_id}", response_model=StudentAssessmentOut)
def get_my_assessment(assessment_id: UUID, claims: dict = Depends(require_student)) -> StudentAssessmentOut:
    """The caller's own questions, in their order, without answers."""
    assessment = queries.get_student_assessment(assessment_id, claims["sub"])
    if assessment is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not found")
    items = []
    for item in assessment.pop("items"):
        options, _ = _shown(item)
        items.append({"position": item["position"], "type": item["type"], "prompt": item["body"]["prompt"], "options": options})
    return StudentAssessmentOut(**assessment, question_count=len(items), items=items)
