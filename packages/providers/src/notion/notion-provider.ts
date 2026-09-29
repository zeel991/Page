import { segment } from '../path-guard.js';
import { Http } from '../http.js';
import type {
  KnowledgeDocument,
  KnowledgeProvider,
  KnowledgeSearchResult,
} from '../types.js';

/**
 * Notion adapter.
 *
 * Used for runbooks and service documentation during an investigation, and for
 * writing incident postmortems afterwards.
 *
 * Notion is not a document store with a `content` field — a page is a tree of typed
 * blocks, and its title lives in a property whose *name* varies by database. Both are
 * handled here so callers deal in plain text:
 *
 *  - Reading a page means paginating its children and rendering each block. Blocks we
 *    do not render (images, embeds, databases) are reported as a placeholder line
 *    rather than dropped silently, so an investigation can tell that a runbook had
 *    content it could not read.
 *  - Notion requires an explicit API version header; omitting it fails at runtime
 *    rather than at build time.
 */

const NOTION_VERSION = '2022-06-28';

/** Notion's block content cap. Longer text must be split across blocks. */
const MAX_BLOCK_TEXT = 2000;

/**
 * Notion takes at most 100 children when creating a page, and at most 100 per
 * append (developers.notion.com: post-page `children` maxItems 100;
 * patch-block-children "a limit of 100 block children"). Checked 2026-09-29.
 */
export const MAX_CHILDREN_PER_REQUEST = 100;

/** How deep nested blocks (toggles, sub-bullets) are read before saying so. */
const MAX_BLOCK_DEPTH = 3;

interface RichText {
  type?: string;
  plain_text?: string;
  text?: { content?: string };
}

interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean;
  [key: string]: unknown;
}

interface NotionPage {
  id: string;
  url?: string;
  properties?: Record<string, { type?: string; title?: RichText[] }>;
  parent?: { type?: string; page_id?: string; database_id?: string };
}

function plain(rich: RichText[] | undefined): string {
  return (rich ?? []).map((r) => r.plain_text ?? r.text?.content ?? '').join('');
}

/**
 * A page's title lives in whichever property has type `title`. Its name is `title`
 * on a standalone page but arbitrary inside a database ("Name", "Runbook", …), so
 * the property is found by type rather than by key.
 */
export function pageTitle(page: NotionPage): string {
  for (const prop of Object.values(page.properties ?? {})) {
    if (prop?.type === 'title') return plain(prop.title);
  }
  return 'Untitled';
}

/** Render one block as a line of text. */
export function renderBlock(block: NotionBlock): string {
  const body = block[block.type] as { rich_text?: RichText[]; checked?: boolean; language?: string } | undefined;
  const text = plain(body?.rich_text);

  switch (block.type) {
    case 'paragraph':
      return text;
    case 'heading_1':
      return `# ${text}`;
    case 'heading_2':
      return `## ${text}`;
    case 'heading_3':
      return `### ${text}`;
    case 'bulleted_list_item':
      return `- ${text}`;
    case 'numbered_list_item':
      return `1. ${text}`;
    case 'to_do':
      return `- [${body?.checked ? 'x' : ' '}] ${text}`;
    case 'code':
      return `\`\`\`${body?.language ?? ''}\n${text}\n\`\`\``;
    case 'quote':
      return `> ${text}`;
    case 'callout':
      return `> ${text}`;
    case 'divider':
      return '---';
    default:
      // Not dropped: an investigation must be able to tell that the runbook
      // contained something this adapter could not read.
      return text || `[unrendered ${block.type} block]`;
  }
}

/** Split plain text into Notion paragraph blocks, respecting the length cap. */
export function toBlocks(content: string): unknown[] {
  const blocks: unknown[] = [];
  for (const paragraph of content.split(/\n{2,}/)) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;

    // A run of "- " lines is a list, not a paragraph that happens to contain
    // newlines. Notion has a block type for this; collapsing it into one
    // paragraph renders the whole thing as a single grey slab and loses the
    // per-item structure that made it a list in the source.
    const lines = trimmed.split('\n');
    if (lines.every((l) => /^[-*]\s+/.test(l.trim()))) {
      for (const line of lines) {
        blocks.push(
          ...chunked(line.trim().replace(/^[-*]\s+/, ''), (chunk) => ({
            object: 'block',
            type: 'bulleted_list_item',
            bulleted_list_item: { rich_text: toRichText(chunk) },
          })),
        );
      }
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = heading[1]!.length;
      blocks.push({
        object: 'block',
        type: `heading_${level}`,
        [`heading_${level}`]: { rich_text: toRichText(heading[2]!.slice(0, MAX_BLOCK_TEXT)) },
      });
      continue;
    }

    blocks.push(
      ...chunked(trimmed, (chunk) => ({
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: toRichText(chunk) },
      })),
    );
  }
  return blocks;
}

/**
 * Inline markdown to Notion rich text.
 *
 * Notion does not parse markup inside a text node: a block whose content is the
 * string "**UNVERIFIABLE**" renders with the asterisks showing, and a markdown
 * link renders as literal brackets. Both appear in the incident write-up, so the
 * emphasis and the link to the pull request have to be built as annotated spans.
 *
 * Deliberately limited to bold, inline code and links — the three the write-up
 * actually uses. A fuller markdown parser would be more surface than this needs.
 */
const INLINE = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|`([^`]+)`/g;

export function toRichText(text: string): unknown[] {
  const out: unknown[] = [];
  const push = (content: string, annotations?: Record<string, boolean>, link?: string) => {
    if (content === '') return;
    out.push({
      type: 'text',
      text: { content, ...(link ? { link: { url: link } } : {}) },
      ...(annotations ? { annotations } : {}),
    });
  };

  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    push(text.slice(last, m.index));
    if (m[1] !== undefined) push(m[1], undefined, m[2]);
    else if (m[3] !== undefined) push(m[3], { bold: true });
    else if (m[4] !== undefined) push(m[4], { code: true });
    last = m.index + m[0].length;
  }
  push(text.slice(last));
  return out.length > 0 ? out : [{ type: 'text', text: { content: text } }];
}

/** Split text that exceeds Notion's per-block limit across several blocks. */
function chunked(text: string, make: (chunk: string) => unknown): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < text.length; i += MAX_BLOCK_TEXT) out.push(make(text.slice(i, i + MAX_BLOCK_TEXT)));
  return out;
}

export interface NotionProviderOptions {
  baseUrl?: string;
  token?: string;
  /** Default parent for created pages, e.g. an incident postmortem database. */
  parentPageId?: string;
  parentDatabaseId?: string;
  fetchImpl?: typeof globalThis.fetch;
}

export class NotionProvider implements KnowledgeProvider {
  readonly kind = 'knowledge' as const;
  private readonly http: Http;

  constructor(private readonly opts: NotionProviderOptions) {
    this.http = new Http({
      baseUrl: opts.baseUrl ?? 'https://api.notion.com',
      headers: {
        'notion-version': NOTION_VERSION,
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
  }

  async search(query: string, limit = 10): Promise<KnowledgeSearchResult[]> {
    const res = await this.http.post<{ results?: NotionPage[] }>('/v1/search', {
      query,
      page_size: limit,
      filter: { property: 'object', value: 'page' },
    });
    return (res.results ?? []).slice(0, limit).map((page) => ({
      id: page.id,
      title: pageTitle(page),
      url: page.url ?? `https://notion.so/${page.id.replace(/-/g, '')}`,
      // Notion search returns no snippet, so the title is the honest excerpt.
      // Fabricating one by fetching and truncating every result would cost a
      // request per hit for a guess at relevance.
      excerpt: pageTitle(page),
    }));
  }

  async getDocument(id: string): Promise<KnowledgeDocument | null> {
    const page = await this.http.getOptional<NotionPage>(`/v1/pages/${segment(id, 'page id')}`);
    if (!page) return null;

    const lines = await this.readChildren(id, 0);
    return {
      id: page.id,
      title: pageTitle(page),
      url: page.url ?? `https://notion.so/${page.id.replace(/-/g, '')}`,
      content: lines.join('\n'),
    };
  }

  /**
   * A block's children, rendered, with nested children indented beneath them.
   *
   * Children are paginated; a long runbook silently truncated at 100 blocks would
   * be worse than useless during an incident. Nested blocks — a toggle's body, a
   * sub-list — were not read at all; they are now, to a bounded depth, and what
   * lies deeper is marked rather than dropped.
   */
  private async readChildren(blockId: string, depth: number): Promise<string[]> {
    const lines: string[] = [];
    const indent = '  '.repeat(depth);
    let cursor: string | undefined;
    do {
      const res = await this.http.get<{ results?: NotionBlock[]; next_cursor?: string | null; has_more?: boolean }>(
        `/v1/blocks/${segment(blockId, 'block id')}/children`,
        { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
      );
      for (const block of res.results ?? []) {
        lines.push(indent + renderBlock(block));
        if (block.has_children) {
          if (depth + 1 >= MAX_BLOCK_DEPTH) lines.push(`${indent}  [nested content deeper than ${MAX_BLOCK_DEPTH} levels not read]`);
          else lines.push(...(await this.readChildren(block.id, depth + 1)));
        }
      }
      cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
    } while (cursor);
    return lines;
  }

  /**
   * The name of a database's title property.
   *
   * A page created in a database must set the title under the database's own name
   * for it ("Name", "Incident", …). Sending `title` is refused there.
   */
  private async databaseTitleProperty(databaseId: string): Promise<string> {
    const db = await this.http.get<{ properties?: Record<string, { type?: string }> }>(
      `/v1/databases/${segment(databaseId, 'database id')}`,
    );
    const found = Object.entries(db.properties ?? {}).find(([, p]) => p?.type === 'title');
    if (!found) throw new Error(`Notion database ${databaseId} has no title property.`);
    return found[0];
  }

  async createDocument(input: { title: string; content: string; parentId?: string }): Promise<KnowledgeDocument> {
    const parentId = input.parentId ?? this.opts.parentPageId ?? this.opts.parentDatabaseId;
    if (!parentId) {
      throw new Error(
        'NotionProvider.createDocument needs a parent: pass parentId, or configure ' +
          'parentPageId / parentDatabaseId. Notion cannot create an orphan page.',
      );
    }
    const isDatabase = Boolean(input.parentId ? false : this.opts.parentDatabaseId && !this.opts.parentPageId);

    const titleProperty = isDatabase ? await this.databaseTitleProperty(parentId) : 'title';
    const blocks = toBlocks(input.content);
    const res = await this.http.post<NotionPage>('/v1/pages', {
      parent: isDatabase ? { database_id: parentId } : { page_id: parentId },
      properties: {
        [titleProperty]: { title: [{ type: 'text', text: { content: input.title } }] },
      },
      children: blocks.slice(0, MAX_CHILDREN_PER_REQUEST),
    });

    // The rest is appended in batches. A failure part-way leaves a page that exists
    // but is incomplete, and that is said rather than returned as the document.
    for (let at = MAX_CHILDREN_PER_REQUEST; at < blocks.length; at += MAX_CHILDREN_PER_REQUEST) {
      try {
        await this.http.patch(`/v1/blocks/${segment(res.id, 'block id')}/children`, {
          children: blocks.slice(at, at + MAX_CHILDREN_PER_REQUEST),
        });
      } catch (err) {
        throw new Error(
          `Notion page ${res.url ?? res.id} was created but only its first ${at} of ${blocks.length} blocks ` +
            `were written: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    }

    return {
      id: res.id,
      title: input.title,
      url: res.url ?? `https://notion.so/${res.id.replace(/-/g, '')}`,
      content: input.content,
    };
  }
}
