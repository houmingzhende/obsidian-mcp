import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";
import { ensureMarkdownExtension, validateVaultPath } from "../../utils/path.js";
import { fileExists } from "../../utils/files.js";
import { createNoteNotFoundError, handleFsError } from "../../utils/errors.js";
import { createTool } from "../../utils/tool-factory.js";
import { parseNote, findSection, replaceSection, NoteOperationResult } from "../../utils/notes.js";

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
    .min(1, "Heading cannot be empty")
    .describe("The heading text to find (without the # symbols, e.g. 'Introduction' not '## Introduction')"),
  content: z.string()
    .describe("The new content for the section (should include the heading line if you want to keep it)"),
  exactMatch: z.boolean()
    .optional()
    .default(false)
    .describe("If true, require exact heading match; if false, allow partial match")
}).strict();

type ReplaceNoteSectionInput = z.infer<typeof schema>;

async function replaceNoteSection(
  vaultPath: string,
  filename: string,
  heading: string,
  content: string,
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

    // Find the section
    const section = findSection(parsed.content, heading, exactMatch);

    if (!section || !section.heading) {
      return {
        success: false,
        message: `Heading "${heading}" not found in note`,
        path: fullPath,
        operation: "replace-note-section",
        changed: false,
        details: {
          searchHeading: heading,
          exactMatch
        }
      };
    }

    // Replace the section
    const newNoteContent = replaceSection(parsed.content, section, content);
    const newRawContent = stringifyNote({
      ...parsed,
      content: newNoteContent
    });

    await fs.writeFile(fullPath, newRawContent);

    return {
      success: true,
      message: `Section "${section.heading.text}" replaced successfully`,
      path: fullPath,
      operation: "replace-note-section",
      changed: true,
      details: {
        heading: section.heading.text,
        level: section.heading.level,
        oldLines: section.endLine - section.startLine + 1,
        newLines: content.split('\n').length
      }
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes('Invalid frontmatter')) {
      throw error;
    }
    throw handleFsError(error, 'replace note section');
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

  if (result.details?.heading) {
    parts.push(`Heading: ${'#'.repeat(result.details.level)} ${result.details.heading}`);
  }

  return parts.join('\n');
}

export function createReplaceNoteSectionTool(vaults: Map<string, string>) {
  return createTool<ReplaceNoteSectionInput>({
    name: "replace-note-section",
    description: `Replace an entire section in a note based on its heading.

A section is all content from a heading until the next heading of the same or higher level.

Examples:
- Replace section: { "vault": "vault1", "filename": "note.md", "heading": "Introduction", "content": "## Introduction\\n\\nNew introduction content..." }
- Exact match: { "vault": "vault1", "filename": "note.md", "heading": "API", "content": "## API\\n\\nNew API docs...", "exactMatch": true }`,
    schema,
    handler: async (args, vaultPath) => {
      const result = await replaceNoteSection(
        vaultPath,
        args.filename,
        args.heading,
        args.content,
        args.exactMatch || false,
        args.folder
      );
      return { content: [{ type: "text", text: formatResult(result) }] };
    }
  }, vaults);
}
