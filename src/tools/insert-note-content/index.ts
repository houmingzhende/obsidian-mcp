import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";
import { ensureMarkdownExtension, validateVaultPath } from "../../utils/path.js";
import { fileExists } from "../../utils/files.js";
import { createNoteNotFoundError, handleFsError } from "../../utils/errors.js";
import { createTool } from "../../utils/tool-factory.js";
import { parseNote, findSection, insertAtSection, extractHeadings, NoteOperationResult } from "../../utils/notes.js";

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
  heading: z.string()
    .optional()
    .describe("The heading to insert relative to (without # symbols). If not provided, inserts at start/end of note."),
  content: z.string()
    .min(1, "Content cannot be empty")
    .describe("The content to insert"),
  position: z.enum(['before', 'after', 'start', 'end'])
    .describe("Where to insert: 'before'/'after' a heading, or 'start'/'end' of the note"),
  exactMatch: z.boolean()
    .optional()
    .default(false)
    .describe("If true, require exact heading match; if false, allow partial match")
}).strict();

type InsertNoteContentInput = z.infer<typeof schema>;

async function insertNoteContent(
  vaultPath: string,
  filename: string,
  content: string,
  position: 'before' | 'after' | 'start' | 'end',
  heading: string | undefined,
  exactMatch: boolean,
  folder?: string
): Promise<NoteOperationResult> {
  const sanitizedFilename = ensureMarkdownExtension(filename);
  const fullPath = folder
    ? path.join(vaultPath, folder, sanitizedFilename)
    : path.join(vaultPath, sanitizedFilename);

  validateVaultPath(vaultPath, fullPath);

  try {
    if (!await fileExists(fullPath)) {
      throw createNoteNotFoundError(filename);
    }

    const rawContent = await fs.readFile(fullPath, "utf-8");
    const parsed = parseNote(rawContent);

    let newNoteContent: string;

    if (position === 'start') {
      // Insert at the beginning of the content
      newNoteContent = content + '\n\n' + parsed.content;
    } else if (position === 'end') {
      // Insert at the end of the content
      newNoteContent = parsed.content.trimEnd() + '\n\n' + content;
    } else {
      // Insert before/after a heading
      if (!heading) {
        return {
          success: false,
          message: "Heading is required when position is 'before' or 'after'",
          path: fullPath,
          operation: "insert-note-content",
          changed: false
        };
      }

      const section = findSection(parsed.content, heading, exactMatch);

      if (!section || !section.heading) {
        return {
          success: false,
          message: `Heading "${heading}" not found in note`,
          path: fullPath,
          operation: "insert-note-content",
          changed: false,
          details: {
            searchHeading: heading,
            exactMatch
          }
        };
      }

      newNoteContent = insertAtSection(parsed.content, section, content, position);
    }

    const newRawContent = stringifyNote({
      ...parsed,
      content: newNoteContent
    });

    await fs.writeFile(fullPath, newRawContent);

    return {
      success: true,
      message: `Content inserted ${position}${heading ? ` "${heading}"` : ''}`,
      path: fullPath,
      operation: "insert-note-content",
      changed: true,
      details: {
        position,
        heading: heading || null,
        insertedLines: content.split('\n').length
      }
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes('Invalid frontmatter')) {
      throw error;
    }
    throw handleFsError(error, 'insert note content');
  }
}

function formatResult(result: NoteOperationResult): string {
  const parts: string[] = [];

  if (result.success) {
    parts.push(`✓ ${result.message}`);
  } else {
    parts.push(`✗ ${result.message}`);
  }

  parts.push(`Path: ${result.path}`);

  if (result.details?.insertedLines !== undefined) {
    parts.push(`Inserted ${result.details.insertedLines} line(s)`);
  }

  return parts.join('\n');
}

export function createInsertNoteContentTool(vaults: Map<string, string>) {
  return createTool<InsertNoteContentInput>({
    name: "insert-note-content",
    description: `Insert content at a specific position in a note.

Positions:
- 'start': Insert at the beginning of the note
- 'end': Insert at the end of the note
- 'before': Insert before a specific heading
- 'after': Insert after a specific heading (after the section content)

Examples:
- Append to end: { "vault": "vault1", "filename": "note.md", "content": "New paragraph", "position": "end" }
- Insert before heading: { "vault": "vault1", "filename": "note.md", "heading": "References", "content": "## New Section\\n\\nContent...", "position": "before" }
- Insert after heading: { "vault": "vault1", "filename": "note.md", "heading": "Introduction", "content": "More intro details", "position": "after" }`,
    schema,
    handler: async (args, vaultPath) => {
      const result = await insertNoteContent(
        vaultPath,
        args.filename,
        args.content,
        args.position,
        args.heading,
        args.exactMatch || false,
        args.folder
      );
      return { content: [{ type: "text", text: formatResult(result) }] };
    }
  }, vaults);
}
