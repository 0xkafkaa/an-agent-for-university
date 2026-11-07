export const $ = id => document.getElementById(id);
export const timezone = 'Europe/Paris';
const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
export function parisDate(value = new Date()) {
  const parts = Object.fromEntries(dateFormat.formatToParts(value).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function node(tag, text, className) {
  const el = document.createElement(tag);
  if (text) el.textContent = text;
  if (className) el.className = className;
  return el;
}
export async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(path, body === undefined ? {} : {
    method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]').content }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || 'Request failed.');
    error.status = response.status; error.code = result.code;
    throw error;
  }
  return result;
}
