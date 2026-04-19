import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";
import { ensureMarkdownExtension, validateVaultPath } from "../../utils/path.js";
import { fileExists } from "../../utils/files.js";
import { createNoteNotFoundError, handleFsError } from "../../utils/errors.js";
import { createTool } from "../../utils/tool-factory.js";
import { parseNote, extractHeadings, NoteOperationResult, NoteHeading } from "../../utils/notes.js";

const schema = z.object({
  vault: z.string()
    .min(1, "Vault name cannot be empty")
    .describe("Name of the vault containing the note"),
  filename: z.string()
    .min(1, "Filename cannot be empty")
    .refine(name => !name.includes('/') && !name.includes('\\'),
      "Filename cannot contain path separators - use the 'folder' parameter for paths instead")
    .describe("Just the note name without any path separators (e.g. 'my-note.md', NOT 'folder/my-note.md')"),
  folder: z.string()
    .optional()
    .refine(folder => !folder || !path.isAbsolute(folder),
      "Folder must be a relative path")
    .describe("Optional subfolder path relative to vault root"),
  minLevel: z.number()
    .min(1)
    .max(6)
    .optional()
    .describe("Minimum heading level to include (1-6)"),
  maxLevel: z.number()
    .min(1)
    .max(6)
    .optional()
    .describe("Maximum heading level to include (1-6)")
}).strict();

type ListNoteHeadingsInput = z.infer<typeof schema>;

async function listNoteHeadings(
  vaultPath: string,
  filename: string,
  folder?: string,
  minLevel?: number,
  maxLevel?: number
): Promise<NoteOperationResult & { headings: NoteHeading[] }> {
  const sanitizedFilename = ensureMarkdownExtension(filename);
  const fullPath = folder
    ? path.join(vaultPath, folder, sanitizedFilename)
    : path.join(vaultPath, sanitizedFilename);

  validateVaultPath(vaultPath, fullPath);

  try {
    if (!await fileExists(fullPath)) {
      throw createNoteNotFoundError(filename);
    }

    const content = await fs.readFile(fullPath, "utf-8");
    const parsed = parseNote(content);
    const allHeadings = extractHeadings(parsed.content);

    // Filter by level
    let headings = allHeadings;
    if (minLevel !== undefined) {
      headings = headings.filter(h => h.level >= minLevel);
    }
    if (maxLevel !== undefined) {
      headings = headings.filter(h => h.level <= maxLevel);
    }

    return {
      success: true,
      message: `Found ${headings.length} heading(s)`,
      path: fullPath,
      operation: "list-note-headings",
      changed: false,
      headings,
      details: {
        totalHeadings: allHeadings.length,
        filteredHeadings: headings.length,
        hasFrontmatter: parsed.hasFrontmatter,
        frontmatterKeys: Object.keys(parsed.frontmatter)
      }
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes('Invalid frontmatter')) {
      throw error;
    }
    throw handleFsError(error, 'list note headings');
  }
}

function formatResult(result: NoteOperationResult & { headings: NoteHeading[] }): string {
  const parts: string[] = [];

  parts.push(result.message);
  parts.push(`Path: ${result.path}`);

  if (result.details?.hasFrontmatter) {
    parts.push(`Frontmatter keys: ${result.details.frontmatterKeys?.join(', ') || 'none'}`);
  }

  if (result.headings.length === 0) {
    parts.push('\n(no headings found)');
    return parts.join('\n');
  }

  parts.push('\n--- Headings ---');

  for (const heading of result.headings) {
    const indent = '  '.repeat(heading.level - 1);
    const prefix = '#'.repeat(heading.level);
    parts.push(`${indent}${prefix} ${heading.text} (line ${heading.line})`);
  }

  return parts.join('\n');
}

export function createListNoteHeadingsTool(vaults: Map<string, string>) {
  return createTool<ListNoteHeadingsInput>({
    name: "list-note-headings",
    description: `List all headings in a note with their levels and line numbers.

Use this to understand the structure of a note before editing sections.

Examples:
- List all headings: { "vault": "vault1", "filename": "note.md" }
- Only H1 and H2: { "vault": "vault1", "filename": "note.md", "minLevel": 1, "maxLevel": 2 }
- Only H2 and below: { "vault": "vault1", "filename": "note.md", "minLevel": 2 }`,
    schema,
    handler: async (args, vaultPath) => {
      const result = await listNoteHeadings(
        vaultPath,
        args.filename,
        args.folder,
        args.minLevel,
        args.maxLevel
      );
      return { content: [{ type: "text", text: formatResult(result) }] };
    }
  }, vaults);
}
