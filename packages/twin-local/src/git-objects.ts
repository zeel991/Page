import { createHash } from 'node:crypto';

/**
 * Real git objects for the twin's repositories.
 *
 * The twin's commit and tree ids are git's own object ids, computed from the same
 * bytes git would store, so a `git clone` of the twin checks out exactly the tree
 * its REST API describes, and a sha read from one is valid in the other.
 */

export type GitObjectType = 'blob' | 'tree' | 'commit';

export interface GitObject {
  type: GitObjectType;
  body: Buffer;
}

export function objectId(type: GitObjectType, body: Buffer): string {
  return createHash('sha1').update(`${type} ${body.length}\0`).update(body).digest('hex');
}

export function blobObject(content: string): { sha: string; object: GitObject } {
  const body = Buffer.from(content, 'utf8');
  return { sha: objectId('blob', body), object: { type: 'blob', body } };
}

interface Dir {
  files: Map<string, string>;
  dirs: Map<string, Dir>;
}

/**
 * The tree for a set of files, and every object it needs.
 *
 * Entries are ordered as git orders them: by name, with a directory compared as
 * though its name ended in `/`.
 */
export function treeObjects(files: ReadonlyMap<string, string>): { sha: string; objects: Map<string, GitObject> } {
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, content] of files) {
    const parts = path.split('/').filter(Boolean);
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      let next = dir.dirs.get(part);
      if (!next) dir.dirs.set(part, (next = { files: new Map(), dirs: new Map() }));
      dir = next;
    }
    dir.files.set(parts[parts.length - 1]!, content);
  }

  const objects = new Map<string, GitObject>();
  const write = (dir: Dir): string => {
    const entries: { name: string; sortKey: string; mode: string; sha: string }[] = [];
    for (const [name, content] of dir.files) {
      const blob = blobObject(content);
      objects.set(blob.sha, blob.object);
      entries.push({ name, sortKey: name, mode: '100644', sha: blob.sha });
    }
    for (const [name, sub] of dir.dirs) entries.push({ name, sortKey: `${name}/`, mode: '40000', sha: write(sub) });
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.sortKey), Buffer.from(b.sortKey)));
    const body = Buffer.concat(
      entries.flatMap((e) => [Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.sha, 'hex')]),
    );
    const sha = objectId('tree', body);
    objects.set(sha, { type: 'tree', body });
    return sha;
  };
  return { sha: write(root), objects };
}

export interface CommitFields {
  tree: string;
  parents: readonly string[];
  authorName: string;
  authorEmail: string;
  /** ISO time; used for both author and committer. */
  committedAt: string;
  message: string;
}

export function commitObject(c: CommitFields): { sha: string; object: GitObject } {
  const seconds = Math.floor(Date.parse(c.committedAt) / 1000);
  const who = `${c.authorName} <${c.authorEmail}> ${Number.isFinite(seconds) ? seconds : 0} +0000`;
  const text =
    `tree ${c.tree}\n` +
    c.parents.map((p) => `parent ${p}\n`).join('') +
    `author ${who}\ncommitter ${who}\n\n${c.message.endsWith('\n') ? c.message : `${c.message}\n`}`;
  const body = Buffer.from(text, 'utf8');
  return { sha: objectId('commit', body), object: { type: 'commit', body } };
}

/** A commit's id from its tree of files. */
export function commitId(c: Omit<CommitFields, 'tree'> & { files: ReadonlyMap<string, string> }): string {
  return commitObject({ ...c, tree: treeObjects(c.files).sha }).sha;
}
