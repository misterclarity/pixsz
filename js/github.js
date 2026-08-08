/* GitHub Contents API client — the optional "photos survive this device" layer.

   Everything here talks only to api.github.com (or raw.githubusercontent.com for
   public repos, which needs no credentials). The token never goes anywhere else. */

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

function b64(bytes) {
  // btoa() on a 3MB string built with spread/apply blows the argument limit on
  // some engines, so walk it in chunks.
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

async function blobToBase64(blob) {
  return b64(new Uint8Array(await blob.arrayBuffer()));
}

function slug(name) {
  const base = (name || 'photo').replace(/\.[^.]+$/, '');
  return base.normalize('NFKD')
    .replace(/[^\w-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
    .toLowerCase() || 'photo';
}

/** photos/2026/08/20260808-142233-a3f1-beach.jpg */
export function buildPath(dir, name, when = new Date()) {
  const p = n => String(n).padStart(2, '0');
  const stamp = `${when.getFullYear()}${p(when.getMonth() + 1)}${p(when.getDate())}`
    + `-${p(when.getHours())}${p(when.getMinutes())}${p(when.getSeconds())}`;
  const rand = Math.random().toString(16).slice(2, 6);
  const folder = `${when.getFullYear()}/${p(when.getMonth() + 1)}`;
  const prefix = dir ? `${dir.replace(/^\/+|\/+$/g, '')}/` : '';
  return `${prefix}${folder}/${stamp}-${rand}-${slug(name)}.jpg`;
}

export class GitHubStore {
  constructor(config = {}) {
    this.token = config.token || '';
    this.owner = config.owner || '';
    this.repo = config.repo || '';
    this.branch = config.branch || 'main';
    this.dir = (config.dir || 'photos').replace(/^\/+|\/+$/g, '');
    this.isPrivate = config.isPrivate !== false;
  }

  get configured() {
    return Boolean(this.token && this.owner && this.repo);
  }

  async request(path, init = {}) {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: `Bearer ${this.token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });

    if (!res.ok) throw new GitHubError(await describe(res), res.status);
    if (res.status === 204) return null;

    const type = res.headers.get('content-type') || '';
    return type.includes('json') ? res.json() : res.blob();
  }

  /** Confirms the token works and the repo/branch exist. Returns repo info. */
  async verify() {
    if (!this.configured) throw new GitHubError('Token, owner and repo are all required', 0);

    const repo = await this.request(`/repos/${this.owner}/${this.repo}`);
    this.isPrivate = repo.private;
    if (!this.branch) this.branch = repo.default_branch;

    if (!repo.permissions || !repo.permissions.push) {
      throw new GitHubError(
        'That token can read the repo but not write to it — it needs Contents: Read and write',
        403,
      );
    }

    try {
      await this.request(`/repos/${this.owner}/${this.repo}/branches/${encodeURIComponent(this.branch)}`);
    } catch (err) {
      if (err.status === 404) {
        throw new GitHubError(`Branch "${this.branch}" doesn't exist in that repo`, 404);
      }
      throw err;
    }

    return repo;
  }

  /** Every image under the configured folder, in one tree call. */
  async list() {
    let tree;
    try {
      tree = await this.request(
        `/repos/${this.owner}/${this.repo}/git/trees/${encodeURIComponent(this.branch)}?recursive=1`,
      );
    } catch (err) {
      // An empty repo has no commits, so it has no tree. That's not an error.
      if (err.status === 404 || err.status === 409) return { files: [], truncated: false };
      throw err;
    }

    const prefix = this.dir ? `${this.dir}/` : '';
    const files = (tree.tree || [])
      .filter(n => n.type === 'blob'
        && n.path.startsWith(prefix)
        && /\.(jpe?g|png|gif|webp|avif)$/i.test(n.path))
      .map(n => ({ path: n.path, sha: n.sha, size: n.size }));

    return { files, truncated: Boolean(tree.truncated) };
  }

  rawUrl(path) {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    return `https://raw.githubusercontent.com/${this.owner}/${this.repo}`
      + `/${encodeURIComponent(this.branch)}/${encoded}`;
  }

  /** Downloads one file's bytes, by blob sha (works for private repos too). */
  async download(file) {
    if (!this.isPrivate) {
      const res = await fetch(this.rawUrl(file.path), { cache: 'force-cache' });
      if (res.ok) return res.blob();
      // Fall through to the API — the repo may have flipped to private.
    }
    return this.request(`/repos/${this.owner}/${this.repo}/git/blobs/${file.sha}`, {
      headers: { Accept: 'application/vnd.github.raw' },
    });
  }

  async upload(path, blob, message) {
    const body = {
      message: message || `Add ${path.split('/').pop()}`,
      content: await blobToBase64(blob),
      branch: this.branch,
    };
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    const res = await this.request(
      `/repos/${this.owner}/${this.repo}/contents/${encoded}`,
      { method: 'PUT', body: JSON.stringify(body) },
    );
    return { path: res.content.path, sha: res.content.sha, url: res.content.download_url };
  }

  /** Reads a JSON file, returning its sha so it can be written back safely. */
  async readJson(path) {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    try {
      const res = await this.request(
        `/repos/${this.owner}/${this.repo}/contents/${encoded}?ref=${encodeURIComponent(this.branch)}`,
      );
      // Base64 from the API arrives with newlines, which atob rejects.
      const text = new TextDecoder().decode(
        Uint8Array.from(atob(res.content.replace(/\s/g, '')), c => c.charCodeAt(0)),
      );
      return { data: JSON.parse(text), sha: res.sha };
    } catch (err) {
      if (err.status === 404) return { data: null, sha: null };
      throw err;
    }
  }

  /**
   * Writes JSON, retrying once against a fresh sha. Two devices editing
   * captions at the same time is rare but a lost update is silent, so the
   * caller passes a merge function rather than a finished blob.
   */
  async writeJson(path, build, message) {
    const encoded = path.split('/').map(encodeURIComponent).join('/');

    for (let attempt = 0; attempt < 2; attempt++) {
      const { data, sha } = await this.readJson(path);
      const next = build(data);
      const body = {
        message: message || `Update ${path}`,
        content: await blobToBase64(new Blob([`${JSON.stringify(next, null, 2)}\n`])),
        branch: this.branch,
        ...(sha ? { sha } : {}),
      };
      try {
        const res = await this.request(
          `/repos/${this.owner}/${this.repo}/contents/${encoded}`,
          { method: 'PUT', body: JSON.stringify(body) },
        );
        return res.content.sha;
      } catch (err) {
        // 409/422 here means someone else wrote first; re-read and reapply.
        if ((err.status === 409 || err.status === 422) && attempt === 0) continue;
        throw err;
      }
    }
    throw new GitHubError('Could not update the photo index — try again', 409);
  }

  async remove(path, sha, message) {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    await this.request(`/repos/${this.owner}/${this.repo}/contents/${encoded}`, {
      method: 'DELETE',
      body: JSON.stringify({
        message: message || `Delete ${path.split('/').pop()}`,
        sha,
        branch: this.branch,
      }),
    });
  }
}

async function describe(res) {
  let detail = '';
  try {
    const data = await res.json();
    detail = data.message || '';
    if (Array.isArray(data.errors) && data.errors.length) {
      detail += ` (${data.errors.map(e => e.message || e.code).join(', ')})`;
    }
  } catch { /* non-JSON error body */ }

  if (res.status === 401) return 'Token rejected — check it hasn\'t expired or been revoked';
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset') || 0) * 1000;
    const mins = reset ? Math.max(1, Math.ceil((reset - Date.now()) / 60000)) : null;
    return `GitHub rate limit reached${mins ? ` — try again in ~${mins} min` : ''}`;
  }
  if (res.status === 403) return detail || 'Token lacks permission for that repo';
  if (res.status === 404) return detail || 'Not found — check the owner, repo and token scope';
  if (res.status === 409) return 'Conflict — the branch moved underneath us, try again';
  if (res.status === 413) return 'File too large for the GitHub Contents API';
  if (res.status === 422) return detail || 'GitHub rejected the file';
  return detail || `GitHub error ${res.status}`;
}
