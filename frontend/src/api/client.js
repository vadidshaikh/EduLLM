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

export { ApiError };
