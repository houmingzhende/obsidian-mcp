import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";
import { ensureMarkdownExtension, validateVaultPath } from "../../utils/path.js";
import { fileExists } from "../../utils/files.js";
import { createNoteNotFoundError, handleFsError } from "../../utils/errors.js";
import { createTool } from "../../utils/tool-factory.js";
import { parseNote, stringifyNote, removeFrontmatterKeys, NoteOperationResult } from "../../utils/notes.js";

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
  keys: z.array(z.string().min(1))
    .min(1, "At least one key must be specified")
    .describe("List of frontmatter keys to remove")
}).strict();

type RemoveFrontmatterKeysInput = z.infer<typeof schema>;

async function removeKeysFromFrontmatter(
  vaultPath: string,
  filename: string,
  keys: string[],
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

    if (!parsed.hasFrontmatter || Object.keys(parsed.frontmatter).length === 0) {
      return {
        success: true,
        message: "No frontmatter to remove keys from",
        path: fullPath,
        operation: "remove-frontmatter-keys",
        changed: false,
        details: {
          removed: [],
          notFound: keys
        }
      };
    }

    const oldFrontmatter = { ...parsed.frontmatter };
    const { frontmatter: newFrontmatter, removed, notFound } = removeFrontmatterKeys(parsed.frontmatter, keys);

    const changed = removed.length > 0;

    if (changed) {
      parsed.frontmatter = newFrontmatter;
      parsed.hasFrontmatter = Object.keys(newFrontmatter).length > 0;
      const newContent = stringifyNote(parsed);
      await fs.writeFile(fullPath, newContent);
    }

    return {
      success: true,
      message: changed
        ? `Removed ${removed.length} key(s) from frontmatter`
        : "No keys removed (none of the specified keys existed)",
      path: fullPath,
      operation: "remove-frontmatter-keys",
      changed,
      warnings: notFound.length > 0 ? [`Keys not found: ${notFound.join(', ')}`] : undefined,
      details: {
        oldFrontmatter,
        newFrontmatter,
        removed,
        notFound
      }
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes('Invalid frontmatter')) {
      throw error;
    }
    throw handleFsError(error, 'remove frontmatter keys');
  }
}

function formatResult(result: NoteOperationResult): string {
  const parts: string[] = [];

  parts.push(result.message);
  parts.push(`Path: ${result.path}`);

  if (result.details?.removed && result.details.removed.length > 0) {
    parts.push(`\nRemoved keys: ${result.details.removed.join(', ')}`);
  }

  if (result.warnings && result.warnings.length > 0) {
    parts.push(`\nWarnings: ${result.warnings.join(', ')}`);
  }

  if (result.changed && result.details?.newFrontmatter) {
    parts.push('\nRemaining frontmatter:');
    parts.push(JSON.stringify(result.details.newFrontmatter, null, 2));
  }

  return parts.join('\n');
}

export function createRemoveFrontmatterKeysTool(vaults: Map<string, string>) {
  return createTool<RemoveFrontmatterKeysInput>({
    name: "remove-frontmatter-keys",
    description: `Remove specific keys from a note's frontmatter.

Does not affect other frontmatter fields or the note content.

Examples:
- Remove single key: { "vault": "vault1", "filename": "note.md", "keys": ["status"] }
- Remove multiple keys: { "vault": "vault1", "filename": "note.md", "keys": ["status", "priority", "deprecated"] }`,
    schema,
    handler: async (args, vaultPath) => {
      const result = await removeKeysFromFrontmatter(vaultPath, args.filename, args.keys, args.folder);
      return { content: [{ type: "text", text: formatResult(result) }] };
    }
  }, vaults);
}
