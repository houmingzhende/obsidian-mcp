import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";
import { ensureMarkdownExtension, validateVaultPath } from "../../utils/path.js";
import { fileExists } from "../../utils/files.js";
import { createNoteNotFoundError, handleFsError } from "../../utils/errors.js";
import { createTool } from "../../utils/tool-factory.js";
import { parseNote, stringifyNote, mergeFrontmatter, NoteOperationResult } from "../../utils/notes.js";

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
    .describe("Frontmatter fields to merge into existing frontmatter. Use null to remove a key."),
  arrayStrategy: z.enum(['merge', 'replace', 'append'])
    .optional()
    .default('merge')
    .describe("How to handle array fields: 'merge' (unique values), 'replace' (overwrite), or 'append' (keep all)")
}).strict();

type MergeFrontmatterInput = z.infer<typeof schema>;

async function mergeFrontmatterIntoNote(
  vaultPath: string,
  filename: string,
  frontmatterUpdates: Record<string, any>,
  arrayStrategy: 'merge' | 'replace' | 'append',
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
    const oldFrontmatter = { ...parsed.frontmatter };

    // Merge frontmatter
    parsed.frontmatter = mergeFrontmatter(parsed.frontmatter, frontmatterUpdates, {
      arrays: arrayStrategy
    });

    // Check if anything changed
    const changed = JSON.stringify(oldFrontmatter) !== JSON.stringify(parsed.frontmatter);

    if (changed) {
      parsed.hasFrontmatter = Object.keys(parsed.frontmatter).length > 0;
      const newContent = stringifyNote(parsed);
      await fs.writeFile(fullPath, newContent);
    }

    return {
      success: true,
      message: changed ? "Frontmatter merged successfully" : "No changes needed (values already present)",
      path: fullPath,
      operation: "merge-frontmatter",
      changed,
      details: {
        oldFrontmatter,
        newFrontmatter: parsed.frontmatter,
        mergedKeys: Object.keys(frontmatterUpdates)
      }
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes('Invalid frontmatter')) {
      throw error;
    }
    throw handleFsError(error, 'merge frontmatter');
  }
}

function formatResult(result: NoteOperationResult): string {
  const parts: string[] = [];

  parts.push(result.message);
  parts.push(`Path: ${result.path}`);

  if (result.changed) {
    parts.push('\nMerged keys: ' + (result.details?.mergedKeys?.join(', ') || 'none'));

    if (result.details?.oldFrontmatter && Object.keys(result.details.oldFrontmatter).length > 0) {
      parts.push('\nPrevious frontmatter:');
      parts.push(JSON.stringify(result.details.oldFrontmatter, null, 2));
    }

    parts.push('\nUpdated frontmatter:');
    parts.push(JSON.stringify(result.details?.newFrontmatter, null, 2));
  }

  return parts.join('\n');
}

export function createMergeFrontmatterTool(vaults: Map<string, string>) {
  return createTool<MergeFrontmatterInput>({
    name: "merge-frontmatter",
    description: `Merge new frontmatter fields into a note's existing frontmatter.

Preserves existing fields and only updates/adds the specified fields. Use null as a value to remove a key.

Examples:
- Add fields: { "vault": "vault1", "filename": "note.md", "frontmatter": { "status": "active", "priority": "high" } }
- Remove a field: { "vault": "vault1", "filename": "note.md", "frontmatter": { "status": null } }
- Merge arrays: { "vault": "vault1", "filename": "note.md", "frontmatter": { "tags": ["new-tag"] }, "arrayStrategy": "merge" }`,
    schema,
    handler: async (args, vaultPath) => {
      const result = await mergeFrontmatterIntoNote(
        vaultPath,
        args.filename,
        args.frontmatter,
        args.arrayStrategy || 'merge',
        args.folder
      );
      return { content: [{ type: "text", text: formatResult(result) }] };
    }
  }, vaults);
}
