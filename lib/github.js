// A minimal GitHub REST client: just what the pull-request flow needs, nothing more.
//
//   - Server-side only. The token comes from the GITHUB_TOKEN environment variable and never reaches the browser,
//     a log line, an error message or an API response.
//   - Every owner, repo, branch and file path is validated BEFORE it is placed into a URL, so a crafted value can't
//     reach a different endpoint (path traversal, extra segments) or a different host. All requests go to api.github.com.
//   - `fetch` is injectable so the whole flow is tested against a fake GitHub (tests/prBuilder.test.mjs).
//
// Token permissions needed (fine-grained personal access token, limited to the repositories you want to fix):
//   Contents: read & write · Pull requests: read & write · Metadata: read.

export class GitHubError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "GitHubError";
    this.code = code;
    this.status = status;
  }
}

/* ------------------------------------------------------------------ */
/* validation                                                         */
/* ------------------------------------------------------------------ */

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const REF_RE = /^[A-Za-z0-9._\/-]{1,200}$/;

export const isValidOwner = (s) => typeof s === "string" && OWNER_RE.test(s) && !s.endsWith("-");
export const isValidRepo = (s) => typeof s === "string" && REPO_RE.test(s) && s !== "." && s !== ".." && !s.endsWith(".git");
/** Branch / ref names: conservative subset of what git allows, with the traversal and lock-file traps removed. */
export function isValidBranch(s) {
  return typeof s === "string" && REF_RE.test(s) && !s.startsWith("/") && !s.endsWith("/") && !s.startsWith("-") && !s.includes("..") && !s.includes("//") && !s.endsWith(".lock") && !s.endsWith(".");
}
/** Repository-relative file path: no leading slash, no "." / ".." segments, no backslashes, no .git directory. */
export function isValidRepoPath(p) {
  if (typeof p !== "string" || p.length === 0 || p.length > 500) return false;
  if (p.startsWith("/") || p.endsWith("/") || p.includes("\\") || /[\u0000-\u001f\u007f]/.test(p)) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== ".." && seg.toLowerCase() !== ".git");
}

/** Accepts "owner/repo", "https://github.com/owner/repo", ".../repo.git" and ".../repo/tree/branch/..." */
export function parseRepoUrl(input) {
  const s = String(input ?? "").trim();
  let m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/\s]+)\/([^\/\s#?]+?)(?:\.git)?(?:\/tree\/([^\s#?]+))?\/?(?:[?#].*)?$/i.exec(s);
  if (!m) m = /^([^\/\s]+)\/([^\/\s]+?)(?:\.git)?$/.exec(s);
  if (!m) return null;
  const [, owner, repo, branch] = m;
  if (!isValidOwner(owner) || !isValidRepo(repo)) return null;
  return { owner, repo, branch: branch && isValidBranch(decodeURIComponent(branch)) ? decodeURIComponent(branch) : null };
}

const encPath = (p) => p.split("/").map(encodeURIComponent).join("/");

/* ------------------------------------------------------------------ */
/* client                                                             */
/* ------------------------------------------------------------------ */

export function createGithubClient({ token, fetchImpl, baseUrl = "https://api.github.com" } = {}) {
  if (!token) throw new GitHubError("NO_TOKEN", "GITHUB_TOKEN isn't set. Create a fine-grained personal access token (Contents and Pull requests: read & write, limited to your site repositories) and add it as the GITHUB_TOKEN environment variable.");
  const doFetch = fetchImpl || ((...a) => fetch(...a));

  async function api(method, path, body, { allow404 = false } = {}) {
    let res;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "VertexRank",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new GitHubError("NETWORK", "Couldn't reach GitHub. Check your connection and try again.");
    }
    if (res.ok) return res.status === 204 ? null : res.json();
    if (res.status === 404 && allow404) return null;
    let detail = "";
    try { detail = (await res.json())?.message || ""; } catch { /* no body */ }
    const remaining = res.headers?.get?.("x-ratelimit-remaining");
    if (res.status === 401) throw new GitHubError("BAD_TOKEN", "GitHub rejected the token (invalid, expired or revoked). Create a new one and update GITHUB_TOKEN.", 401);
    if (res.status === 403 && remaining === "0") throw new GitHubError("RATE_LIMIT", "GitHub's rate limit was reached. Wait a few minutes and try again.", 403);
    if (res.status === 403) throw new GitHubError("FORBIDDEN", "The token doesn't have permission for this. It needs Contents and Pull requests (read & write) on this repository.", 403);
    if (res.status === 404) throw new GitHubError("NOT_FOUND", "Not found. Check the repository and branch names — and that the token has access to this repository (private repositories must be selected when you create the token).", 404);
    if (res.status === 409) throw new GitHubError("CONFLICT", `GitHub reported a conflict${detail ? `: ${detail}` : ""}.`, 409);
    if (res.status === 422) throw new GitHubError("UNPROCESSABLE", `GitHub rejected the request${detail ? `: ${detail}` : ""}.`, 422);
    throw new GitHubError("GITHUB_ERROR", `GitHub returned an error (${res.status}).`, res.status);
  }

  const repoPath = (owner, repo) => {
    if (!isValidOwner(owner) || !isValidRepo(repo)) throw new GitHubError("INVALID", "That isn't a valid GitHub owner/repository name.");
    return `/repos/${owner}/${repo}`;
  };
  const branchOk = (b) => { if (!isValidBranch(b)) throw new GitHubError("INVALID", "That isn't a valid branch name."); return b; };

  return {
    async getRepo(owner, repo) {
      const r = await api("GET", repoPath(owner, repo));
      return { fullName: r.full_name, defaultBranch: r.default_branch, private: !!r.private, archived: !!r.archived, canPush: r.permissions ? !!r.permissions.push : null, htmlUrl: r.html_url };
    },

    /** Head commit + its tree for a branch (or any ref name). */
    async getBranchHead(owner, repo, branch) {
      const r = await api("GET", `${repoPath(owner, repo)}/branches/${encPath(branchOk(branch))}`);
      return { sha: r.commit.sha, treeSha: r.commit.commit.tree.sha };
    },

    async getTree(owner, repo, treeSha) {
      if (!/^[0-9a-f]{40}$/i.test(treeSha)) throw new GitHubError("INVALID", "Bad tree id.");
      const r = await api("GET", `${repoPath(owner, repo)}/git/trees/${treeSha}?recursive=1`);
      return { entries: (r.tree || []).map((e) => ({ path: e.path, type: e.type === "tree" ? "tree" : e.type === "blob" ? "blob" : e.type, size: e.size, sha: e.sha })), truncated: !!r.truncated };
    },

    /** Reads a text file at an exact commit. Refuses non-UTF-8 content (it would be corrupted by a text round-trip). */
    async getFile(owner, repo, path, ref) {
      if (!isValidRepoPath(path)) throw new GitHubError("INVALID", "That isn't a valid file path.");
      if (!/^[0-9a-f]{40}$/i.test(ref) && !isValidBranch(ref)) throw new GitHubError("INVALID", "Bad ref.");
      const r = await api("GET", `${repoPath(owner, repo)}/contents/${encPath(path)}?ref=${encodeURIComponent(ref)}`, undefined, { allow404: true });
      if (!r) return null;
      if (Array.isArray(r) || r.type !== "file") throw new GitHubError("NOT_A_FILE", `${path} isn't a file.`);
      if (r.encoding !== "base64" || typeof r.content !== "string") throw new GitHubError("TOO_LARGE", `${path} is too large to edit through the GitHub API (over 1 MB).`);
      const bytes = Buffer.from(r.content, "base64");
      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      if (text.includes("\uFFFD")) throw new GitHubError("NOT_UTF8", `${path} isn't valid UTF-8 text, so it can't be edited safely.`);
      return { text, sha: r.sha, size: r.size };
    },

    /** One commit containing every file (inline contents, no blobs), parented on `baseSha`. Does NOT move any branch. */
    async createCommit(owner, repo, { baseSha, baseTreeSha, files, message }) {
      for (const f of files) if (!isValidRepoPath(f.path)) throw new GitHubError("INVALID", `Invalid file path: ${String(f.path).slice(0, 80)}`);
      const tree = await api("POST", `${repoPath(owner, repo)}/git/trees`, {
        base_tree: baseTreeSha,
        tree: files.map((f) => ({ path: f.path, mode: "100644", type: "blob", content: f.content })),
      });
      const commit = await api("POST", `${repoPath(owner, repo)}/git/commits`, { message, tree: tree.sha, parents: [baseSha] });
      return { sha: commit.sha, treeSha: tree.sha };
    },

    /** Creates a NEW branch pointing at `sha`. Fails (422) if it already exists — it never moves an existing branch. */
    async createBranch(owner, repo, name, sha) {
      branchOk(name);
      await api("POST", `${repoPath(owner, repo)}/git/refs`, { ref: `refs/heads/${name}`, sha });
    },

    async createPull(owner, repo, { title, body, head, base, draft = false }) {
      branchOk(head); branchOk(base);
      const r = await api("POST", `${repoPath(owner, repo)}/pulls`, { title, body, head, base, draft: !!draft });
      return { number: r.number, url: r.html_url };
    },

    async getPull(owner, repo, number) {
      if (!Number.isInteger(number) || number < 1) throw new GitHubError("INVALID", "Bad pull request number.");
      const r = await api("GET", `${repoPath(owner, repo)}/pulls/${number}`);
      return { number: r.number, state: r.state, merged: !!r.merged, mergedAt: r.merged_at || null, closedAt: r.closed_at || null, url: r.html_url, title: r.title, head: r.head?.ref };
    },
  };
}
