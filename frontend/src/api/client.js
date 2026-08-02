const BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

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

export function queryLLM(token, query) {
  return request("/query", { method: "POST", token, body: { query } });
}

export function listDocuments(token) {
  return request("/admin/documents", { token });
}

export function uploadDocument(token, { file, title, allowedRoles }) {
  const form = new FormData();
  form.append("file", file);
  form.append("title", title);
  allowedRoles.forEach((role) => form.append("allowed_roles", role));
  return request("/admin/documents", { method: "POST", token, body: form, isForm: true });
}

export function deleteDocument(token, documentId) {
  return request(`/admin/documents/${documentId}`, { method: "DELETE", token });
}

export { ApiError };
