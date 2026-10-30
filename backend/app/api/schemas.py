from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field


class QueryRequest(BaseModel):
    conversation_id: UUID | None = None
    query: str
    # A workspace or classroom id to search only that scope, or the
    # INSTITUTE scope id (…0001) for the institute library; None searches
    # everything the user can read.
    scope_id: UUID | None = None


class SourceOut(BaseModel):
    title: str
    doc_id: str


class QueryResponse(BaseModel):
    conversation_id: UUID
    answer: str
    chart: dict[str, Any] | None
    sources: list[SourceOut]


class ConversationOut(BaseModel):
    id: UUID
    title: str | None
    is_pinned: bool
    updated_at: datetime
    doc_ids: list[str] = []  # up to 3 docs its answers used, most recent first


class UpdateConversationRequest(BaseModel):
    title: str | None = None
    is_pinned: bool | None = None


class MessageOut(BaseModel):
    id: UUID
    role: str
    content: str
    chart_config: dict[str, Any] | None
    sources: list[SourceOut] | None
    created_at: datetime


class LoginRequest(BaseModel):
    email: str


class LoginResponse(BaseModel):
    detail: str


class VerifyRequest(BaseModel):
    token: str


class TokenResponse(BaseModel):
    access_token: str


class DocumentOut(BaseModel):
    id: UUID
    title: str
    filename: str
    workspace_id: UUID | None
    visibility: str
    classroom_ids: list[UUID]
    status: str
    progress: int
    version: int
    uploaded_by: str
    uploaded_by_name: str | None = None
    uploaded_at: datetime
    updated_by: str | None
    updated_by_name: str | None = None
    updated_at: datetime


class UploadResponse(BaseModel):
    document_id: UUID
    status: str


class UpdateDocumentRequest(BaseModel):
    title: str | None = None
    # Change access: both together. classroom_ids only with "classrooms".
    visibility: Literal["institute", "faculty", "workspace", "classrooms"] | None = None
    classroom_ids: list[UUID] = []


class DocumentEventOut(BaseModel):
    id: UUID
    document_id: UUID
    document_title: str
    action: str
    actor_email: str
    actor_name: str
    version: int
    workspace_id: UUID | None
    created_at: datetime


class NotificationOut(BaseModel):
    id: UUID
    kind: str
    document_id: UUID
    document_title: str
    version: int
    actor_name: str
    created_at: datetime
    is_read: bool


class NotificationsResponse(BaseModel):
    unread_count: int
    notifications: list[NotificationOut]


class WorkspaceOut(BaseModel):
    id: UUID
    name: str
    kind: str
    owner_email: str
    my_role: str
    member_count: int
    classroom_count: int
    created_at: datetime


class CreateWorkspaceRequest(BaseModel):
    name: str


class UpdateWorkspaceRequest(BaseModel):
    name: str


class WorkspaceMemberOut(BaseModel):
    email: str
    name: str | None
    role: str
    added_by: str
    added_at: datetime


class AddMemberRequest(BaseModel):
    email: str


class AddMemberResponse(BaseModel):
    added: bool
    invited: bool  # True when an invite email was sent (no account yet)


class ClassroomOut(BaseModel):
    id: UUID
    workspace_id: UUID
    name: str
    subject: str | None
    term: str | None
    join_code: str
    created_by: str
    created_at: datetime
    archived_at: datetime | None
    student_count: int


class StudentClassroomOut(BaseModel):
    """A classroom as a student sees it: no join code or member list."""
    id: UUID
    name: str
    subject: str | None
    term: str | None
    workspace_name: str


class CreateClassroomRequest(BaseModel):
    name: str
    subject: str | None = None
    term: str | None = None


class UpdateClassroomRequest(BaseModel):
    name: str | None = None
    subject: str | None = None
    term: str | None = None
    archived: bool | None = None


class ClassroomStudentOut(BaseModel):
    email: str
    name: str | None
    added_by: str | None
    joined_at: datetime


class AddStudentsRequest(BaseModel):
    # Free text pasted from a sheet or CSV: emails separated by commas,
    # semicolons, whitespace or new lines.
    emails: str


class AddStudentsResponse(BaseModel):
    added: int
    already_in: int
    rejected: list[str]  # not recognisable as student emails


class JoinClassroomRequest(BaseModel):
    code: str


class ReadableDocumentOut(BaseModel):
    """A document as anyone who can read it sees it: no access details."""
    id: UUID
    title: str
    filename: str


class ScopeOut(BaseModel):
    """One option in the chat's "search in" picker."""
    id: UUID
    kind: str  # personal | shared | classroom
    name: str
    detail: str | None = None


# --- Notes and slide decks (Phase 3) ---


class NoteSourceDocumentOut(BaseModel):
    """A document a note can be written from."""
    id: UUID
    title: str
    version: int
    workspace_id: UUID | None  # None = institute library
    visibility: str


class Slide(BaseModel):
    title: str = ""
    bullets: list[str] = []
    notes: str = ""


class NoteSource(BaseModel):
    doc_id: str
    title: str
    version: int


class SourceStatusOut(BaseModel):
    doc_id: str
    title: str
    used_version: int
    current_version: int | None  # None: the document was removed
    changed: bool


class NoteSummaryOut(BaseModel):
    id: UUID
    workspace_id: UUID
    kind: Literal["slides"]
    title: str
    subject: str | None
    topic: str
    slide_count: int
    source_status: list[SourceStatusOut]
    stale: bool  # a source changed or was removed since it was written
    document_id: UUID | None  # the document it was published as
    document_status: str | None
    document_progress: int | None
    document_visibility: str | None
    document_classroom_ids: list[UUID] | None
    published_at: datetime | None
    created_by: str
    created_by_name: str
    updated_by: str
    updated_by_name: str
    created_at: datetime
    updated_at: datetime


class NoteOut(NoteSummaryOut):
    slides: list[Slide]
    sources: list[NoteSource]


class CreateNoteRequest(BaseModel):
    kind: Literal["slides"] = "slides"  # decks are the only kind
    title: str
    topic: str
    subject: str | None = None
    source_doc_ids: list[UUID]
    instructions: str | None = None  # extra guidance for the draft
    generate: bool = True  # False starts an empty deck from the same sources


class UpdateNoteRequest(BaseModel):
    # The updated_at the editor loaded; the save is refused (409) if the
    # note was saved by someone else since.
    base_updated_at: datetime
    title: str | None = None
    subject: str | None = None
    topic: str | None = None
    slides: list[Slide] | None = None
    # Record the sources' current versions: the faculty member has checked
    # the note against them, so it's no longer stale. Removed sources are
    # dropped.
    mark_up_to_date: bool = False


class ReviseNoteRequest(BaseModel):
    # What to change, in the faculty member's words ("add a slide on TLBs").
    request: str
    # The deck as it is in the editor, so unsaved edits are kept.
    slides: list[Slide]


class RedraftResponse(BaseModel):
    """A proposal only; nothing is saved until the editor saves it."""
    slides: list[Slide]


class PublishNoteRequest(BaseModel):
    visibility: Literal["workspace", "classrooms"]
    classroom_ids: list[UUID] = []


# --- Question bank, quizzes and assignments (Phase 4) ---

QuestionType = Literal["mcq", "short", "long"]


class QuestionContent(BaseModel):
    """A question as written or edited: options and correct only for mcq."""
    type: QuestionType
    difficulty: int = Field(2, ge=1, le=3)
    prompt: str
    options: list[str] = []
    correct: int | None = None  # index into options
    explanation: str = ""  # why the mcq answer is right / the model answer


class QuestionOut(BaseModel):
    id: UUID
    workspace_id: UUID
    subject: str
    topic: str
    type: QuestionType
    difficulty: int
    body: dict  # {prompt, options?}
    answer: dict  # {correct, explanation}
    source_doc_ids: list[UUID]
    status: Literal["draft", "approved"]
    use_count: int  # assessments it's in
    created_by: str
    created_by_name: str
    created_at: datetime
    updated_at: datetime


class GenerateQuestionsRequest(BaseModel):
    source_doc_ids: list[UUID]
    count: int = Field(10, ge=10, le=50)
    # ["mcq"] for quizzes, ["short", "long"] (or one of them) for assignments
    types: list[QuestionType] = ["mcq"]
    difficulties: list[int] = [1, 2, 3]
    instructions: str | None = None


class GenerateQuestionsResponse(BaseModel):
    questions: list[QuestionOut]  # the new drafts
    duplicates: int  # drafts dropped as too close to an existing question


class CreateQuestionRequest(QuestionContent):
    subject: str
    topic: str


class UpdateQuestionRequest(BaseModel):
    subject: str | None = None
    topic: str | None = None
    content: QuestionContent | None = None
    status: Literal["draft", "approved"] | None = None


class SetQuestionsStatusRequest(BaseModel):
    question_ids: list[UUID]
    status: Literal["draft", "approved"]


class SetQuestionsStatusResponse(BaseModel):
    changed: int


class AssessmentConfig(BaseModel):
    kind: Literal["quiz", "assignment"]
    subject: str | None = None  # defaults to the classroom's subject
    count: int = Field(ge=1, le=100)  # questions per set
    # The chapters it covers: only questions generated from these docs.
    # Empty = any doc.
    source_doc_ids: list[UUID] = []
    topics: list[str] = []  # empty = any
    types: list[QuestionType] = []
    difficulties: list[int] = []
    # Quizzes only: at most this many questions in common between any two
    # students' sets. None = no cap (only identical sets are refused).
    max_overlap: int | None = Field(None, ge=0)


class CreateAssessmentRequest(AssessmentConfig):
    title: str
    due_at: datetime | None = None


class ClassroomRuleOut(BaseModel):
    id: UUID
    name: str
    has_assignment: bool


class AssessmentCheckOut(BaseModel):
    """Whether the bank can supply this assessment, before creating it."""
    ok: bool
    message: str
    subject: str | None
    available: int  # matching approved questions (for an assignment: not used by another this term)
    needed: int | None  # questions that would be enough, when short
    students: int
    # Assignments: the classrooms with the same subject and term, which
    # can't share questions.
    sharing: list[ClassroomRuleOut] = []


class AssessmentSummaryOut(BaseModel):
    id: UUID
    classroom_id: UUID
    kind: Literal["quiz", "assignment"]
    title: str
    subject: str
    config: dict
    student_count: int  # quizzes: students with a set
    created_by: str
    created_by_name: str
    created_at: datetime
    due_at: datetime | None


class AssessmentItemOut(BaseModel):
    position: int
    question_id: UUID
    topic: str
    type: QuestionType
    difficulty: int
    prompt: str
    options: list[str]  # in the order this set shows them
    correct: int | None  # index into `options` as shown
    explanation: str


class AssessmentSetOut(BaseModel):
    student_email: str | None  # None: the whole class (assignment)
    student_name: str | None
    items: list[AssessmentItemOut]


class ResultOut(BaseModel):
    """One student's marks on an assessment (faculty view)."""
    student_email: str
    student_name: str | None
    score: int | None  # None: hasn't submitted, or an assignment (not marked in the app)
    total: int | None
    submitted_at: datetime | None
    late: bool = False  # submitted after the due date
    marked_by: str | None = None  # assignment ticked off by this faculty member (None: the student)
    file_name: str | None = None  # assignment: the PDF they handed in
    file_size: int | None = None
    # quizzes: position -> the option they picked, as their set shows it (None = blank)
    choices: dict[int, int | None] = {}


class AssessmentOut(AssessmentSummaryOut):
    sets: list[AssessmentSetOut]
    # Quizzes: students in the classroom now who have no set (joined later).
    missing_students: list[str]
    # Everyone who has the assessment (quiz: a set; assignment: the
    # classroom's students), submitted or not, plus anyone who submitted
    # and has since left.
    results: list[ResultOut]


class AssessmentStatOut(BaseModel):
    id: UUID
    kind: Literal["quiz", "assignment"]
    title: str
    due_at: datetime | None
    created_at: datetime
    assigned: int  # students who have it
    submitted: int  # submitted (quiz) or handed in (assignment)
    late: int
    average: float | None  # quizzes: mean score, 0..1


class StudentStatOut(BaseModel):
    email: str
    name: str | None
    quizzes: int
    assignments: int
    handed_in: int  # of quizzes + assignments
    missed: int  # past due and not handed in
    late: int
    average: float | None  # quiz average, 0..1


class ChapterStatOut(BaseModel):
    doc_id: UUID | None  # None: questions written by hand
    title: str
    answered: int  # quiz answers to its questions
    right: int
    accuracy: float


class HardQuestionOut(BaseModel):
    question_id: UUID
    prompt: str
    assessment: str
    answered: int
    right: int
    accuracy: float


class ClassroomAnalyticsOut(BaseModel):
    students: int
    quizzes: int
    assignments: int
    average: float | None  # every quiz submission, 0..1
    completion: float | None  # share of everything assigned that's been handed in
    assessments: list[AssessmentStatOut]
    student_rows: list[StudentStatOut]
    chapters: list[ChapterStatOut]  # weakest first
    hardest: list[HardQuestionOut]  # most often wrong, answered by at least two


class StudentAssessmentSummaryOut(BaseModel):
    id: UUID
    kind: Literal["quiz", "assignment"]
    title: str
    subject: str
    classroom_id: UUID
    classroom_name: str
    question_count: int
    due_at: datetime | None
    created_at: datetime
    # Their marks, once submitted.
    score: int | None = None
    total: int | None = None
    submitted_at: datetime | None = None


class StudentItemOut(BaseModel):
    """A question as a student sees it. The answer only once results are
    visible (submitted, and the due date has passed if there is one)."""
    position: int
    type: QuestionType
    prompt: str
    options: list[str]
    choice: int | None = None  # what they picked, as shown
    # Once submitted: whether their pick was right. Doesn't give away the
    # answer before results are visible (`correct`).
    is_right: bool | None = None
    correct: int | None = None
    explanation: str | None = None


class StudentAssessmentOut(StudentAssessmentSummaryOut):
    items: list[StudentItemOut]
    closed: bool  # past due without a submission: can't be answered any more
    results_visible: bool
    file_name: str | None = None  # assignment: the PDF they handed in (None: none, or a paper copy)
    file_size: int | None = None


class AnswerIn(BaseModel):
    position: int
    choice: int | None  # index into the options as shown; None = left blank


class SubmitAnswersRequest(BaseModel):
    answers: list[AnswerIn]
