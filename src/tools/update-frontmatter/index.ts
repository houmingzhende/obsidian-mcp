import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";
import { ensureMarkdownExtension, validateVaultPath } from "../../utils/path.js";
import { fileExists } from "../../utils/files.js";
import { createNoteNotFoundError, handleFsError } from "../../utils/errors.js";
import { createTool } from "../../utils/tool-factory.js";
import { parseNote, stringifyNote, NoteOperationResult } from "../../utils/notes.js";

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
  frontmatter: z.record(z.any())
    .describe("Complete frontmatter object to set (replaces existing frontmatter entirely)")
}).strict();

type UpdateFrontmatterInput = z.infer<typeof schema>;

async function updateFrontmatter(
  vaultPath: string,
  filename: string,
  frontmatter: Record<string, any>,
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
    const oldFrontmatter = parsed.frontmatter;

    // Update frontmatter
    parsed.frontmatter = frontmatter;
    parsed.hasFrontmatter = Object.keys(frontmatter).length > 0;

    const newContent = stringifyNote(parsed);
    await fs.writeFile(fullPath, newContent);

    return {
      success: true,
      message: "Frontmatter updated successfully",
      path: fullPath,
      operation: "update-frontmatter",
      changed: true,
      details: {
        oldFrontmatter,
        newFrontmatter: frontmatter
      }
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes('Invalid frontmatter')) {
      throw error;
    }
    throw handleFsError(error, 'update frontmatter');
  }
}

function formatResult(result: NoteOperationResult): string {
  const parts: string[] = [];

  parts.push(result.message);
  parts.push(`Path: ${result.path}`);

  if (result.details?.oldFrontmatter && Object.keys(result.details.oldFrontmatter).length > 0) {
    parts.push('\nPrevious frontmatter:');
    parts.push(JSON.stringify(result.details.oldFrontmatter, null, 2));
  }

  parts.push('\nNew frontmatter:');
  parts.push(JSON.stringify(result.details?.newFrontmatter, null, 2));

  return parts.join('\n');
}

export function createUpdateFrontmatterTool(vaults: Map<string, string>) {
  return createTool<UpdateFrontmatterInput>({
    name: "update-frontmatter",
    description: `Replace the entire frontmatter of a note with new values.

This completely replaces the existing frontmatter. Use merge-frontmatter if you want to preserve existing values.

Examples:
- Set new frontmatter: { "vault": "vault1", "filename": "note.md", "frontmatter": { "title": "My Note", "tags": ["important"] } }
- Clear frontmatter: { "vault": "vault1", "filename": "note.md", "frontmatter": {} }`,
    schema,
    handler: async (args, vaultPath) => {
      const result = await updateFrontmatter(vaultPath, args.filename, args.frontmatter, args.folder);
      return { content: [{ type: "text", text: formatResult(result) }] };
    }
  }, vaults);
}
