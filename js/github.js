// GitHub の zmk-config リポジトリから .keymap を読み書きする（REST API）

const API = 'https://api.github.com';

function headers(token) {
  const h = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function b64decodeUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function b64encodeUtf8(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function explain(res) {
  let detail = '';
  try { detail = (await res.json()).message || ''; } catch { /* ignore */ }
  if (res.status === 401) return 'トークンが正しくありません（401）。';
  if (res.status === 403) return `アクセスが拒否されました（403）。${/rate limit/i.test(detail) ? 'API の回数制限です。トークンを設定すると増えます。' : 'トークンの権限（Contents: Read and write）を確認してください。'}`;
  if (res.status === 404) return '見つかりません（404）。リポジトリ名・ブランチ・パスを確認してください。非公開リポジトリならトークンが必要です。';
  if (res.status === 409) return 'ファイルが他で更新されています（409）。もう一度読み込んでから保存してください。';
  if (res.status === 422) return `内容が受け付けられませんでした（422）。${detail}`;
  return `GitHub エラー ${res.status}: ${detail}`;
}

export function parseRepo(input) {
  const s = String(input || '').trim().replace(/\.git$/, '');
  const m = /(?:github\.com[/:])?([\w.-]+)\/([\w.-]+)\/?$/.exec(s);
  return m ? { owner: m[1], repo: m[2] } : null;
}

export async function getDefaultBranch({ owner, repo, token }) {
  const res = await fetch(`${API}/repos/${owner}/${repo}`, { headers: headers(token) });
  if (!res.ok) throw new Error(await explain(res));
  return (await res.json()).default_branch;
}

export async function findKeymaps({ owner, repo, branch, token }) {
  const res = await fetch(`${API}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, { headers: headers(token) });
  if (!res.ok) throw new Error(await explain(res));
  const data = await res.json();
  return (data.tree || []).filter((t) => t.type === 'blob' && t.path.endsWith('.keymap')).map((t) => t.path);
}

export async function getFile({ owner, repo, branch, path, token }) {
  const url = `${API}/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, { headers: headers(token), cache: 'no-store' });
  if (!res.ok) throw new Error(await explain(res));
  const data = await res.json();
  if (Array.isArray(data) || data.type !== 'file') throw new Error('指定したパスはファイルではありません。');
  return { text: b64decodeUtf8(data.content), sha: data.sha };
}

export async function putFile({ owner, repo, branch, path, token, text, sha, message }) {
  if (!token) throw new Error('保存するには GitHub のトークンが必要です。');
  const url = `${API}/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: b64encodeUtf8(text), sha, branch }),
  });
  if (!res.ok) throw new Error(await explain(res));
  const data = await res.json();
  return { sha: data.content.sha, commitUrl: data.commit.html_url };
}

export function actionsUrl({ owner, repo }) {
  return `https://github.com/${owner}/${repo}/actions`;
}

export const OFFICIAL = { owner: 'kureyakey', repo: 'zmk-config-zonkey', branch: 'main', path: 'config/zonkey.keymap' };

export async function fetchOfficial() {
  const url = `https://raw.githubusercontent.com/${OFFICIAL.owner}/${OFFICIAL.repo}/${OFFICIAL.branch}/${OFFICIAL.path}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`公式キーマップを取得できませんでした（${res.status}）`);
  return res.text();
}

export async function findFiles({ owner, repo, branch, token }, test) {
  const res = await fetch(`${API}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, { headers: headers(token) });
  if (!res.ok) throw new Error(await explain(res));
  const data = await res.json();
  return (data.tree || []).filter((t) => t.type === 'blob' && test(t.path)).map((t) => t.path);
}

/**
 * 複数のファイルを 1 つのコミットで保存する（GitHub Actions のビルドも 1 回で済む）
 * files: [{ path, text }]
 */
export async function commitFiles({ owner, repo, branch, token, files, message }) {
  if (!token) throw new Error('保存するには GitHub のトークンが必要です。');
  const h = { ...headers(token), 'Content-Type': 'application/json' };
  const base = `${API}/repos/${owner}/${repo}/git`;
  const call = async (url, opts = {}) => {
    const res = await fetch(url, { headers: h, cache: 'no-store', ...opts });
    if (!res.ok) throw new Error(await explain(res));
    return res.json();
  };
  const ref = await call(`${base}/ref/heads/${encodeURIComponent(branch)}`);
  const parentSha = ref.object.sha;
  const parent = await call(`${base}/commits/${parentSha}`);
  const tree = await call(`${base}/trees`, {
    method: 'POST',
    body: JSON.stringify({ base_tree: parent.tree.sha, tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.text })) }),
  });
  const commit = await call(`${base}/commits`, {
    method: 'POST',
    body: JSON.stringify({ message, tree: tree.sha, parents: [parentSha] }),
  });
  await call(`${base}/refs/heads/${encodeURIComponent(branch)}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha }),
  });
  return { sha: commit.sha, commitUrl: `https://github.com/${owner}/${repo}/commit/${commit.sha}` };
}
