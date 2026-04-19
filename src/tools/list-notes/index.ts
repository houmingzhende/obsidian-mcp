import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";
import { validateVaultPath } from "../../utils/path.js";
import { handleFsError } from "../../utils/errors.js";
import { createTool } from "../../utils/tool-factory.js";
import { parseNote, NoteOperationResult } from "../../utils/notes.js";

const schema = z.object({
  vault: z.string()
    .min(1, "Vault name cannot be empty")
    .describe("Name of the vault"),
  folder: z.string()
    .optional()
    .describe("Filter by folder path (relative to vault root)"),
  tags: z.array(z.string())
    .optional()
    .describe("Filter by tags (notes must have ALL specified tags)"),
  hasFrontmatterKey: z.string()
    .optional()
    .describe("Filter by frontmatter key existence"),
  frontmatter: z.record(z.any())
    .optional()
    .describe("Filter by frontmatter key-value pairs (all must match)"),
  limit: z.number()
    .min(1)
    .max(100)
    .optional()
    .default(50)
    .describe("Maximum number of notes to return")
}).strict();

type ListNotesInput = z.infer<typeof schema>;

interface NoteEntry {
  filename: string;
  path: string;
  folder: string;
  frontmatter: Record<string, any>;
  tags: string[];
  hasFrontmatter: boolean;
}

async function listNotes(
  vaultPath: string,
  options: {
    folder?: string;
    tags?: string[];
    hasFrontmatterKey?: string;
    frontmatter?: Record<string, any>;
    limit: number;
  }
): Promise<NoteOperationResult & { notes: NoteEntry[] }> {
  const notes: NoteEntry[] = [];
  const searchPath = options.folder ? path.join(vaultPath, options.folder) : vaultPath;

  validateVaultPath(vaultPath, searchPath);

  async function scanDir(dirPath: string, relativePath: string): Promise<void> {
    const items = await fs.readdir(dirPath, { withFileTypes: true });

    for (const item of items) {
      if (item.name.startsWith('.')) continue;

      const itemPath = path.join(dirPath, item.name);
      const itemRelative = relativePath ? path.join(relativePath, item.name) : item.name;

      if (item.isDirectory()) {
        await scanDir(itemPath, itemRelative);
      } else if (item.isFile() && item.name.endsWith('.md')) {
        try {
          const content = await fs.readFile(itemPath, 'utf-8');
          const parsed = parseNote(content);

          // Extract tags from frontmatter and content
          const fmTags: string[] = Array.isArray(parsed.frontmatter.tags)
            ? parsed.frontmatter.tags
            : [];
          const contentTags = extractInlineTags(parsed.content);
          const allTags = [...new Set([...fmTags, ...contentTags])];

          const entry: NoteEntry = {
            filename: item.name,
            path: itemRelative,
            folder: relativePath || '',
            frontmatter: parsed.frontmatter,
            tags: allTags,
            hasFrontmatter: parsed.hasFrontmatter
          };

          // Apply filters
          if (options.tags && options.tags.length > 0) {
            const hasAllTags = options.tags.every(tag =>
              allTags.some(t => t.toLowerCase() === tag.toLowerCase())
            );
            if (!hasAllTags) continue;
          }

          if (options.hasFrontmatterKey) {
            if (!(options.hasFrontmatterKey in parsed.frontmatter)) continue;
          }

          if (options.frontmatter) {
            const matchesAll = Object.entries(options.frontmatter).every(([key, value]) => {
              return parsed.frontmatter[key] === value;
            });
            if (!matchesAll) continue;
          }

          notes.push(entry);

          if (notes.length >= options.limit) return;
        } catch {
          // Skip files that can't be parsed
        }
      }
    }
  }

  try {
    await scanDir(searchPath, options.folder || '');

    return {
      success: true,
      message: `Found ${notes.length} matching notes`,
      path: searchPath,
      operation: "list-notes",
      changed: false,
      notes,
      details: {
        count: notes.length,
        filters: {
          folder: options.folder,
          tags: options.tags,
          hasFrontmatterKey: options.hasFrontmatterKey,
          frontmatter: options.frontmatter
        }
      }
    };
  } catch (error) {
    throw handleFsError(error, 'list notes');
  }
}

function extractInlineTags(content: string): string[] {
  const tags = new Set<string>();
  const tagPattern = /(?<!`)#[a-zA-Z0-9][a-zA-Z0-9/]*/g;

  const lines = content.split('\n');
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    const matches = line.match(tagPattern);
    if (matches) {
      matches.forEach(tag => tags.add(tag.slice(1)));
    }
  }

  return Array.from(tags);
}

function formatResult(result: NoteOperationResult & { notes: NoteEntry[] }): string {
  const parts: string[] = [];

  parts.push(result.message);

  if (result.details?.filters) {
    const filterParts: string[] = [];
    if (result.details.filters.folder) filterParts.push(`folder: ${result.details.filters.folder}`);
    if (result.details.filters.tags) filterParts.push(`tags: ${result.details.filters.tags.join(', ')}`);
    if (result.details.filters.hasFrontmatterKey) filterParts.push(`has key: ${result.details.filters.hasFrontmatterKey}`);
    if (result.details.filters.frontmatter) filterParts.push(`frontmatter: ${JSON.stringify(result.details.filters.frontmatter)}`);
    if (filterParts.length > 0) {
      parts.push(`Filters: ${filterParts.join('; ')}`);
    }
  }

  if (result.notes.length === 0) {
    parts.push('\n(no matching notes)');
    return parts.join('\n');
  }

  parts.push('\n--- Notes ---');

  for (const note of result.notes) {
    const fmIndicator = note.hasFrontmatter ? '📋 ' : '';
    const tagStr = note.tags.length > 0 ? ` [${note.tags.slice(0, 3).join(', ')}${note.tags.length > 3 ? '...' : ''}]` : '';
    parts.push(`${fmIndicator}${note.path}${tagStr}`);
  }

  return parts.join('\n');
}

export function createListNotesTool(vaults: Map<string, string>) {
  return createTool<ListNotesInput>({
    name: "list-notes",
    description: `List notes in a vault with optional filtering.

Supports filtering by folder, tags, and frontmatter.

Examples:
- List all notes: { "vault": "vault1" }
- Filter by folder: { "vault": "vault1", "folder": "journal" }
- Filter by tags: { "vault": "vault1", "tags": ["important", "project"] }
- Filter by frontmatter: { "vault": "vault1", "frontmatter": { "status": "active" } }
- Filter by key existence: { "vault": "vault1", "hasFrontmatterKey": "priority" }`,
    schema,
    handler: async (args, vaultPath) => {
      const result = await listNotes(vaultPath, {
        folder: args.folder,
        tags: args.tags,
        hasFrontmatterKey: args.hasFrontmatterKey,
        frontmatter: args.frontmatter,
        limit: args.limit || 50
      });
      return { content: [{ type: "text", text: formatResult(result) }] };
    }
  }, vaults);
}
