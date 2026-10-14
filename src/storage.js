// Optional save to this browser only. Every call is wrapped, because storage can be
// blocked (private windows, strict settings) and the app must keep working without it.
const KEY = 'fairshift:v1';

export function loadSaved() {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function save(data) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

export function forget() {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // nothing to remove, or storage is blocked
  }
}
