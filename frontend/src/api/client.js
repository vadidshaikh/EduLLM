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
 */
export function queryLLM(token, conversationId, query) {
  return request("/query", { method: "POST", token, body: { conversation_id: conversationId, query } });
}

/**
 * Sends a user's question to the backend and streams the answer back as it's generated.
 * Calls the matching handler in `handlers` as each newline-delimited JSON event arrives:
 * onStart({conversation_id}), onToken(text), onDone({answer, chart, sources}), onError(message).
 * Uses fetch + a manually-read stream (not EventSource) because EventSource can't send the
 * Authorization header this API requires.
 */
export async function queryLLMStream(token, conversationId, query, { onStart, onToken, onDone, onError } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}/query/stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({ conversation_id: conversationId, query }),
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
 * Renames a conversation and/or updates its pinned state.
 */
export function updateConversation(token, conversationId, { title, isPinned }) {
  const body = {};
  if (title !== undefined) body.title = title;
  if (isPinned !== undefined) body.is_pinned = isPinned;
  return request(`/conversations/${conversationId}`, { method: "PATCH", token, body });
}

/**
 * Fetches the list of documents uploaded to the admin panel.
 */
export function listDocuments(token) {
  return request("/admin/documents", { token });
}

/**
 * Uploads a file with a title and allowed roles to the backend as form data.
 */
export function uploadDocument(token, { file, title, allowedRoles }) {
  const form = new FormData();
  form.append("file", file);
  form.append("title", title);
  allowedRoles.forEach((role) => form.append("allowed_roles", role));
  return request("/admin/documents", { method: "POST", token, body: form, isForm: true });
}

/**
 * Deletes a specific uploaded document from the backend.
 */
export function deleteDocument(token, documentId) {
  return request(`/admin/documents/${documentId}`, { method: "DELETE", token });
}

/**
 * Changes which roles can access an existing document.
 */
export function updateDocumentRoles(token, documentId, allowedRoles) {
  return request(`/admin/documents/${documentId}`, {
    method: "PATCH",
    token,
    body: { allowed_roles: allowedRoles },
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

export { ApiError };
