const BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";

/**
 * Represents an error returned by the backend API, keeping track of the HTTP status code along with the message.
 */
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Sends an HTTP request to the backend API and returns the parsed JSON response, throwing an ApiError if it fails.
 */
async function request(path, { method = "GET", token, body, isForm = false } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body && !isForm) headers["Content-Type"] = "application/json";

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: isForm ? body : body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new ApiError(res.status, detail.detail || res.statusText);
  }

  if (res.status === 204) return null;
  return res.json();
}

/**
 * Asks the backend to email a sign-in link to the given address.
 */
export function requestMagicLink(email) {
  return request("/auth/login", { method: "POST", body: { email } });
}

/**
 * Checks a sign-in link's token with the backend and returns the login result.
 */
export function verifyMagicLink(token) {
  return request("/auth/verify", { method: "POST", body: { token } });
}

/**
 * Sends a user's question to the backend and returns the AI's answer for the given conversation.
 * `scopeId` (a workspace or classroom id) narrows the search to one workspace or classroom; null searches everything.
 */
export function queryLLM(token, conversationId, query, scopeId = null) {
  return request("/query", {
    method: "POST",
    token,
    body: { conversation_id: conversationId, query, scope_id: scopeId },
  });
}

/**
 * Sends a user's question to the backend and streams the answer back as it's generated.
 * Calls the matching handler in `handlers` as each newline-delimited JSON event arrives:
 * onStart({conversation_id}), onToken(text), onDone({answer, chart, sources}), onError(message).
 * Uses fetch + a manually-read stream (not EventSource) because EventSource can't send the
 * Authorization header this API requires.
 */
export async function queryLLMStream(
  token,
  conversationId,
  query,
  { scopeId = null, onStart, onToken, onDone, onError } = {}
) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}/query/stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({ conversation_id: conversationId, query, scope_id: scopeId }),
  });

  if (!res.ok || !res.body) {
    const detail = await res.json().catch(() => ({}));
    throw new ApiError(res.status, detail.detail || res.statusText);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const handleLine = (line) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === "start") onStart?.(event);
    else if (event.type === "token") onToken?.(event.text);
    else if (event.type === "done") onDone?.(event);
    else if (event.type === "error") onError?.(event.message);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      handleLine(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
    }
  }
  handleLine(buffer);
}

/**
 * Fetches the list of the user's past conversations.
 */
export function listConversations(token) {
  return request("/conversations", { token });
}

/**
 * Fetches all the messages that belong to a specific conversation.
 */
export function getConversationMessages(token, conversationId) {
  return request(`/conversations/${conversationId}/messages`, { token });
}

/**
 * Deletes a conversation from the backend.
 */
export function deleteConversation(token, conversationId) {
  return request(`/conversations/${conversationId}`, { method: "DELETE", token });
}

/**
 * Deletes a message and everything sent after it in the conversation — used
 * when editing an earlier question, since the old answer (and anything
 * after it) is no longer valid once the question changes.
 */
export function deleteMessagesFrom(token, conversationId, messageId) {
  return request(`/conversations/${conversationId}/messages/${messageId}`, { method: "DELETE", token });
}

/**
 * Renames a conversation and/or updates its pinned state.
 */
export function updateConversation(token, conversationId, { title, isPinned }) {
  const body = {};
  if (title !== undefined) body.title = title;
  if (isPinned !== undefined) body.is_pinned = isPinned;
  return request(`/conversations/${conversationId}`, { method: "PATCH", token, body });
}

/**
 * Builds "?workspace_id=..." for a workspace, or "" for the institute library (workspaceId null).
 */
function workspaceQuery(workspaceId) {
  return workspaceId ? `?workspace_id=${encodeURIComponent(workspaceId)}` : "";
}

/**
 * Fetches the documents in one workspace, or in the institute library when workspaceId is null.
 */
export function listDocuments(token, workspaceId = null) {
  return request(`/admin/documents${workspaceQuery(workspaceId)}`, { token });
}

/**
 * Uploads a file as form data into a workspace (or the institute library when workspaceId is null).
 * `visibility` is "institute" | "faculty" (library) or "workspace" | "classrooms" (workspace);
 * `classroomIds` only with "classrooms".
 */
export function uploadDocument(token, { file, title, workspaceId = null, visibility, classroomIds = [] }) {
  const form = new FormData();
  form.append("file", file);
  form.append("title", title);
  form.append("visibility", visibility);
  if (workspaceId) form.append("workspace_id", workspaceId);
  classroomIds.forEach((id) => form.append("classroom_ids", id));
  return request("/admin/documents", { method: "POST", token, body: form, isForm: true });
}

/**
 * Deletes a specific uploaded document from the backend.
 */
export function deleteDocument(token, documentId) {
  return request(`/admin/documents/${documentId}`, { method: "DELETE", token });
}

/**
 * Changes who can read an existing document (same visibility values as uploadDocument).
 */
export function updateDocumentAccess(token, documentId, { visibility, classroomIds = [] }) {
  return request(`/admin/documents/${documentId}`, {
    method: "PATCH",
    token,
    body: { visibility, classroom_ids: classroomIds },
  });
}

/**
 * Renames an existing document.
 */
export function renameDocument(token, documentId, title) {
  return request(`/admin/documents/${documentId}`, {
    method: "PATCH",
    token,
    body: { title },
  });
}

/**
 * Fetches recent audit events for one workspace's documents (or the institute library's when
 * workspaceId is null), deleted ones included, newest first.
 */
export function listAllDocumentEvents(token, workspaceId = null) {
  return request(`/admin/document-events${workspaceQuery(workspaceId)}`, { token });
}

/**
 * Fetches a document's audit history (uploads, updates, deletes), newest first.
 */
export function listDocumentEvents(token, documentId) {
  return request(`/admin/documents/${documentId}/events`, { token });
}

/**
 * Fetches the user's recent document update/delete notices and their unread count.
 */
export function listNotifications(token) {
  return request("/notifications", { token });
}

/**
 * Marks one notice as read.
 */
export function markNotificationRead(token, notificationId) {
  return request(`/notifications/${notificationId}/read`, { method: "POST", token });
}

/**
 * Marks every notice visible to the user as read.
 */
export function markAllNotificationsRead(token) {
  return request("/notifications/read-all", { method: "POST", token });
}

/**
 * Fetches the ready documents the user can ask about ({id, title}), all of them or only one
 * workspace / classroom (scopeId). Works for students and faculty.
 */
export function listReadableDocuments(token, scopeId = null) {
  return request(`/documents${scopeId ? `?scope_id=${encodeURIComponent(scopeId)}` : ""}`, { token });
}

// --- Workspaces (faculty) ---

/**
 * Fetches the faculty member's workspaces, personal first.
 */
export function listWorkspaces(token) {
  return request("/workspaces", { token });
}

export function createWorkspace(token, name) {
  return request("/workspaces", { method: "POST", token, body: { name } });
}

export function renameWorkspace(token, workspaceId, name) {
  return request(`/workspaces/${workspaceId}`, { method: "PATCH", token, body: { name } });
}

/**
 * Deletes an empty shared workspace (the backend refuses while it still has documents).
 */
export function deleteWorkspace(token, workspaceId) {
  return request(`/workspaces/${workspaceId}`, { method: "DELETE", token });
}

export function listWorkspaceMembers(token, workspaceId) {
  return request(`/workspaces/${workspaceId}/members`, { token });
}

/**
 * Adds a faculty member to a shared workspace by email. Returns {added, invited}.
 */
export function addWorkspaceMember(token, workspaceId, email) {
  return request(`/workspaces/${workspaceId}/members`, { method: "POST", token, body: { email } });
}

/**
 * Removes a member (owner only), or leaves the workspace when `email` is your own.
 */
export function removeWorkspaceMember(token, workspaceId, email) {
  return request(`/workspaces/${workspaceId}/members/${encodeURIComponent(email)}`, { method: "DELETE", token });
}

// --- Classrooms (faculty) ---

export function listClassrooms(token, workspaceId) {
  return request(`/workspaces/${workspaceId}/classrooms`, { token });
}

export function createClassroom(token, workspaceId, { name, subject, term }) {
  return request(`/workspaces/${workspaceId}/classrooms`, { method: "POST", token, body: { name, subject, term } });
}

/**
 * Edits a classroom's name/subject/term and/or archives it ({archived: true}) or restores it.
 */
export function updateClassroom(token, classroomId, changes) {
  return request(`/classrooms/${classroomId}`, { method: "PATCH", token, body: changes });
}

/**
 * Replaces a classroom's join code; the old code stops working.
 */
export function regenerateJoinCode(token, classroomId) {
  return request(`/classrooms/${classroomId}/join-code`, { method: "POST", token });
}

export function listClassroomStudents(token, classroomId) {
  return request(`/classrooms/${classroomId}/students`, { token });
}

/**
 * Bulk-adds students from pasted text (emails, or CSV). Returns {added, already_in, rejected}.
 */
export function addClassroomStudents(token, classroomId, emails) {
  return request(`/classrooms/${classroomId}/students`, { method: "POST", token, body: { emails } });
}

export function removeClassroomStudent(token, classroomId, email) {
  return request(`/classrooms/${classroomId}/students/${encodeURIComponent(email)}`, { method: "DELETE", token });
}

// --- Classrooms (students) ---

/**
 * Fetches the classrooms the student has joined.
 */
export function listMyClassrooms(token) {
  return request("/classrooms", { token });
}

export function joinClassroom(token, code) {
  return request("/classrooms/join", { method: "POST", token, body: { code } });
}

export function leaveClassroom(token, classroomId) {
  return request(`/classrooms/${classroomId}/membership`, { method: "DELETE", token });
}

// --- Notes and slide decks (faculty, Phase 3) ---

/**
 * The ready documents a note in this workspace can be written from: the workspace's own and the
 * institute library's ({id, title, version, workspace_id, visibility}; workspace_id null = library).
 */
export function listNoteSources(token, workspaceId) {
  return request(`/workspaces/${workspaceId}/note-sources`, { token });
}

/**
 * Fetches a workspace's notes and decks (no bodies), most recently edited first.
 */
export function listNotes(token, workspaceId) {
  return request(`/workspaces/${workspaceId}/notes`, { token });
}

/**
 * Creates notes or a deck (`kind`: "notes" | "slides") from source docs. With `generate` the
 * model writes the first draft first, which can take a minute.
 */
export function createNote(token, workspaceId, { kind, title, topic, subject, sourceDocIds, instructions, generate = true }) {
  return request(`/workspaces/${workspaceId}/notes`, {
    method: "POST",
    token,
    body: { kind, title, topic, subject, source_doc_ids: sourceDocIds, instructions, generate },
  });
}

export function getNote(token, noteId) {
  return request(`/notes/${noteId}`, { token });
}

/**
 * Saves edits ({title, subject, topic, body_md, slides, mark_up_to_date}). `baseUpdatedAt` is the
 * note's updated_at when it was loaded; the save fails with 409 if someone else saved since.
 */
export function updateNote(token, noteId, baseUpdatedAt, changes) {
  return request(`/notes/${noteId}`, { method: "PATCH", token, body: { base_updated_at: baseUpdatedAt, ...changes } });
}

export function deleteNote(token, noteId) {
  return request(`/notes/${noteId}`, { method: "DELETE", token });
}

/**
 * Asks for a new draft from the sources' current versions: one "## " section of notes (`section`,
 * its current text), or the whole note/deck. Returns {body_md} or {slides}; nothing is saved.
 */
export function redraftNote(token, noteId, section = null) {
  return request(`/notes/${noteId}/redraft`, { method: "POST", token, body: { section } });
}

/**
 * Publishes the saved note as a workspace document ("workspace" = faculty only, or "classrooms").
 */
export function publishNote(token, noteId, { visibility, classroomIds = [] }) {
  return request(`/notes/${noteId}/publish`, {
    method: "POST",
    token,
    body: { visibility, classroom_ids: classroomIds },
  });
}

/**
 * Downloads the saved note as a file (.pptx for decks, .md for notes) through the browser.
 */
export async function downloadNote(token, noteId) {
  const res = await fetch(`${BASE_URL}/notes/${noteId}/download`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new ApiError(res.status, detail.detail || res.statusText);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "note";
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export { ApiError };
