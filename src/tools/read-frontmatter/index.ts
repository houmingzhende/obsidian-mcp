import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";
import { ensureMarkdownExtension, validateVaultPath } from "../../utils/path.js";
import { fileExists } from "../../utils/files.js";
import { createNoteNotFoundError, handleFsError } from "../../utils/errors.js";
import { createTool } from "../../utils/tool-factory.js";
import { parseNote, NoteOperationResult } from "../../utils/notes.js";

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
    .describe("Optional subfolder path relative to vault root")
}).strict();

type ReadFrontmatterInput = z.infer<typeof schema>;

async function readFrontmatter(
  vaultPath: string,
  filename: string,
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

    return {
      success: true,
      message: "Frontmatter read successfully",
      path: fullPath,
      operation: "read-frontmatter",
      changed: false,
      details: {
        hasFrontmatter: parsed.hasFrontmatter,
        frontmatter: parsed.frontmatter,
        contentPreview: parsed.content.slice(0, 200) + (parsed.content.length > 200 ? '...' : '')
      }
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes('Invalid frontmatter')) {
      throw error;
    }
    throw handleFsError(error, 'read frontmatter');
  }
}

function formatResult(result: NoteOperationResult): string {
  const parts: string[] = [];

  parts.push(result.message);
  parts.push(`Path: ${result.path}`);

  if (result.details?.hasFrontmatter) {
    parts.push('\n--- Frontmatter ---');
    parts.push(JSON.stringify(result.details.frontmatter, null, 2));
  } else {
    parts.push('\nNo frontmatter found in this note.');
  }

  return parts.join('\n');
}

export function createReadFrontmatterTool(vaults: Map<string, string>) {
  return createTool<ReadFrontmatterInput>({
    name: "read-frontmatter",
    description: `Read the frontmatter (YAML metadata) from a note.

Returns the parsed frontmatter as a JSON object, or indicates if no frontmatter exists.

Examples:
- Root note: { "vault": "vault1", "filename": "note.md" }
- Subfolder note: { "vault": "vault1", "filename": "note.md", "folder": "journal/2024" }`,
    schema,
    handler: async (args, vaultPath) => {
      const result = await readFrontmatter(vaultPath, args.filename, args.folder);
      return { content: [{ type: "text", text: formatResult(result) }] };
    }
  }, vaults);
}
