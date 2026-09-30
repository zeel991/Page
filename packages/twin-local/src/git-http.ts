import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { commitObject, treeObjects, type GitObject } from './git-objects.js';
import type { StoredRepository, TwinState } from './store.js';

/**
 * The GitHub twin's git smart-HTTP endpoint: `<github>/<owner>/<repo>.git`.
 *
 * GitHub serves clones from the same host as its web UI, over git's smart-HTTP
 * protocol. So does the twin: each repository is written out as a bare repository of
 * real git objects — the twin's shas are git's own — and served by `git
 * http-backend`, the reference implementation of that protocol. A clone of the twin
 * therefore exercises exactly the client code path a clone of GitHub does, shallow
 * fetches of a pinned sha and partial-clone filters included.
 *
 * Fetch only. The agent writes through the REST API, as it does against GitHub.
 */

export const GIT_PATH = /^\/github\/([^/]+)\/([^/]+?)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

export type RepoAccess = (owner: string, repo: string, token: string) => StoredRepository | undefined;

export class TwinGitServer {
  private readonly written = new Set<string>();

  constructor(private readonly root: string) {}

  async handle(req: IncomingMessage, res: ServerResponse, url: URL, state: TwinState, access: RepoAccess): Promise<void> {
    const m = GIT_PATH.exec(url.pathname)!;
    const [, owner, name, endpoint] = m as unknown as [string, string, string, string];
    const service = endpoint === 'info/refs' ? url.searchParams.get('service') : endpoint;
    if (service === 'git-receive-pack') {
      return send(res, 403, 'Pushing over git is not supported by the twin; write through the REST API.');
    }

    // GitHub takes an installation token as the password of `x-access-token`.
    const header = req.headers.authorization ?? '';
    const basic = /^Basic\s+(.+)$/i.exec(header)?.[1];
    const token = basic ? (Buffer.from(basic, 'base64').toString('utf8').split(':')[1] ?? '') : null;
    // Like the twin's REST API, nothing is readable without an installation token.
    if (!token) return unauthorized(res);
    const repo = access(owner, name, token);
    if (!repo) return unauthorized(res);
    if (!state.repositories.has(repo.fullName)) return send(res, 404, 'Repository not found.');

    const dir = await this.materialise(repo);
    const body = await readRaw(req);
    await cgi(res, body, {
      GIT_PROJECT_ROOT: this.root,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: `/${repo.fullName}.git/${endpoint}`,
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: req.method ?? 'GET',
      CONTENT_TYPE: String(req.headers['content-type'] ?? ''),
      ...(req.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: String(req.headers['content-encoding']) } : {}),
      ...(req.headers['git-protocol'] ? { GIT_PROTOCOL: String(req.headers['git-protocol']) } : {}),
      REMOTE_ADDR: req.socket.remoteAddress ?? '127.0.0.1',
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: dir,
    });
  }

  async dispose(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }

  /** Write the repository's objects and refs as they are now. */
  private async materialise(repo: StoredRepository): Promise<string> {
    const dir = join(this.root, `${repo.fullName}.git`);
    await mkdir(join(dir, 'objects'), { recursive: true });
    await writeFile(
      join(dir, 'config'),
      '[core]\n\trepositoryformatversion = 0\n\tbare = true\n' +
        // What GitHub allows: fetching any reachable sha, and partial-clone filters.
        '[uploadpack]\n\tallowFilter = true\n\tallowReachableSHA1InWant = true\n\tallowAnySHA1InWant = true\n',
    );
    await writeFile(join(dir, 'HEAD'), `ref: refs/heads/${repo.defaultBranch}\n`);

    for (const commit of repo.commits) {
      if (this.written.has(`${dir}:${commit.sha}`)) continue;
      const tree = treeObjects(commit.files);
      const made = commitObject({ ...commit, tree: tree.sha });
      // Every twin commit id is computed this way; a mismatch would serve a clone
      // whose history disagrees with the REST API, so it is an error, not a skip.
      if (made.sha !== commit.sha) throw new Error(`twin commit ${commit.sha} is not a git object id`);
      for (const [sha, obj] of tree.objects) await writeLoose(dir, sha, obj);
      await writeLoose(dir, made.sha, made.object);
      this.written.add(`${dir}:${commit.sha}`);
    }

    // Refs are rewritten whole, so a branch the twin no longer has is gone here too.
    await rm(join(dir, 'refs'), { recursive: true, force: true });
    await mkdir(join(dir, 'refs', 'heads'), { recursive: true });
    await mkdir(join(dir, 'refs', 'tags'), { recursive: true });
    for (const [branch, sha] of repo.branches) {
      const ref = join(dir, 'refs', 'heads', branch);
      await mkdir(join(ref, '..'), { recursive: true });
      await writeFile(ref, `${sha}\n`);
    }
    return dir;
  }
}

async function writeLoose(dir: string, sha: string, obj: GitObject): Promise<void> {
  const path = join(dir, 'objects', sha.slice(0, 2), sha.slice(2));
  if (existsSync(path)) return;
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, deflateSync(Buffer.concat([Buffer.from(`${obj.type} ${obj.body.length}\0`), obj.body])));
}

function readRaw(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Run `git http-backend` as a CGI program and relay its response. */
function cgi(res: ServerResponse, body: Buffer, env: Record<string, string>): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn('git', ['http-backend'], { env: { ...env, CONTENT_LENGTH: String(body.length) }, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => (err += c.toString()));
    child.on('error', (e) => {
      send(res, 500, `git http-backend could not start: ${e.message}`);
      resolve();
    });
    child.on('close', () => {
      const raw = Buffer.concat(out);
      let split = raw.indexOf('\r\n\r\n');
      let gap = 4;
      if (split < 0) {
        split = raw.indexOf('\n\n');
        gap = 2;
      }
      if (split < 0) {
        send(res, 500, `git http-backend failed: ${err.trim() || 'no response'}`);
        return resolve();
      }
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of raw.subarray(0, split).toString('utf8').split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i < 0) continue;
        const key = line.slice(0, i).trim();
        const value = line.slice(i + 1).trim();
        if (key.toLowerCase() === 'status') status = Number.parseInt(value, 10) || 200;
        else headers[key] = value;
      }
      res.writeHead(status, headers);
      res.end(raw.subarray(split + gap));
      resolve();
    });
    child.stdin.end(body);
  });
}

function send(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain' });
  res.end(`${text}\n`);
}

function unauthorized(res: ServerResponse): void {
  res.writeHead(401, { 'content-type': 'text/plain', 'www-authenticate': 'Basic realm="GitHub"' });
  res.end('Bad credentials\n');
}
