/* Settings live in localStorage so they're readable synchronously at boot,
   before the first frame — the grid needs the GitHub config to know whether to
   show remote photos, and IndexedDB is too late for that. */

const KEY = 'pixsz.settings.v1';

const DEFAULTS = {
  resize: true,
  maxEdge: 2048,
  quality: 82,
  gh: { token: '', owner: '', repo: '', branch: 'main', dir: 'photos', isPrivate: true },
};

function merge(base, patch) {
  const out = { ...base, ...patch };
  out.gh = { ...base.gh, ...(patch && patch.gh) };
  return out;
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? merge(DEFAULTS, JSON.parse(raw)) : { ...DEFAULTS, gh: { ...DEFAULTS.gh } };
  } catch {
    return { ...DEFAULTS, gh: { ...DEFAULTS.gh } };
  }
}

export function save(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Private-mode Safari and full quota both land here. Settings simply won't
    // persist; the app still works for this session.
  }
  return settings;
}

export function clearToken(settings) {
  settings.gh.token = '';
  return save(settings);
}
