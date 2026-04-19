import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";
import { ensureMarkdownExtension, validateVaultPath } from "../../utils/path.js";
import { fileExists } from "../../utils/files.js";
import { createNoteNotFoundError, handleFsError } from "../../utils/errors.js";
import { createTool } from "../../utils/tool-factory.js";
import { patchContent, NoteOperationResult } from "../../utils/notes.js";

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
  oldText: z.string()
    .min(1, "oldText cannot be empty")
    .describe("The exact text to find and replace"),
  newText: z.string()
    .describe("The text to replace with"),
  replaceAll: z.boolean()
    .optional()
    .default(false)
    .describe("If true, replace all occurrences; if false, require exactly one match")
}).strict();

type PatchNoteInput = z.infer<typeof schema>;

async function patchNote(
  vaultPath: string,
  filename: string,
  oldText: string,
  newText: string,
  replaceAll: boolean,
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

    const content = await fs.readFile(fullPath, "utf-8");

    // Count occurrences
    const occurrences = (content.split(oldText).length - 1);

    if (occurrences === 0) {
      return {
        success: false,
        message: "Text not found in note",
        path: fullPath,
        operation: "patch-note",
        changed: false,
        details: {
          searchText: oldText.slice(0, 100) + (oldText.length > 100 ? '...' : '')
        }
      };
    }

    if (occurrences > 1 && !replaceAll) {
      return {
        success: false,
        message: `Found ${occurrences} occurrences. Use replaceAll=true to replace all, or provide more specific text.`,
        path: fullPath,
        operation: "patch-note",
        changed: false,
        warnings: [`Multiple matches found: ${occurrences}`],
        details: {
          occurrences,
          searchText: oldText.slice(0, 100) + (oldText.length > 100 ? '...' : '')
        }
      };
    }

    // Perform the replacement
    const result = patchContent(content, oldText, newText, { replaceAll, requireUnique: !replaceAll });

    if (!result) {
      return {
        success: false,
        message: "Failed to apply patch",
        path: fullPath,
        operation: "patch-note",
        changed: false
      };
    }

    await fs.writeFile(fullPath, result.content);

    return {
      success: true,
      message: `Replaced ${result.count} occurrence(s)`,
      path: fullPath,
      operation: "patch-note",
      changed: true,
      details: {
        occurrencesReplaced: result.count,
        oldTextLength: oldText.length,
        newTextLength: newText.length
      }
    };
  } catch (error) {
    throw handleFsError(error, 'patch note');
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

  if (result.warnings && result.warnings.length > 0) {
    parts.push(`Warnings: ${result.warnings.join(', ')}`);
  }

  if (result.details?.occurrencesReplaced !== undefined) {
    parts.push(`Replacements: ${result.details.occurrencesReplaced}`);
  }

  return parts.join('\n');
}

export function createPatchNoteTool(vaults: Map<string, string>) {
  return createTool<PatchNoteInput>({
    name: "patch-note",
    description: `Replace specific text in a note with new text.

This is a precise, surgical edit that only changes the exact matching text. Use this instead of edit-note when you want to modify just a small part of a note.

Important:
- By default, requires exactly one match (fails if 0 or >1 matches)
- Set replaceAll=true to replace all occurrences

Examples:
- Fix a typo: { "vault": "vault1", "filename": "note.md", "oldText": "teh", "newText": "the" }
- Replace all: { "vault": "vault1", "filename": "note.md", "oldText": "old-term", "newText": "new-term", "replaceAll": true }`,
    schema,
    handler: async (args, vaultPath) => {
      const result = await patchNote(
        vaultPath,
        args.filename,
        args.oldText,
        args.newText,
        args.replaceAll || false,
        args.folder
      );
      return { content: [{ type: "text", text: formatResult(result) }] };
    }
  }, vaults);
}
