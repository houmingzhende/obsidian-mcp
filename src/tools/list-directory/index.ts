import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";
import { validateVaultPath } from "../../utils/path.js";
import { handleFsError } from "../../utils/errors.js";
import { createTool } from "../../utils/tool-factory.js";
import { NoteOperationResult } from "../../utils/notes.js";

const schema = z.object({
  vault: z.string()
    .min(1, "Vault name cannot be empty")
    .describe("Name of the vault"),
  path: z.string()
    .optional()
    .default("")
    .describe("Relative path within the vault (empty string for root)"),
  recursive: z.boolean()
    .optional()
    .default(false)
    .describe("If true, list all files recursively; if false, only immediate children"),
  extensions: z.array(z.string())
    .optional()
    .default([".md"])
    .describe("File extensions to include (e.g. ['.md', '.canvas'])")
}).strict();

type ListDirectoryInput = z.infer<typeof schema>;

interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  extension?: string;
}

async function listDirectory(
  vaultPath: string,
  relativePath: string,
  recursive: boolean,
  extensions: string[]
): Promise<NoteOperationResult & { entries: FileEntry[] }> {
  const targetPath = relativePath
    ? path.join(vaultPath, relativePath)
    : vaultPath;

  validateVaultPath(vaultPath, targetPath);

  try {
    const entries: FileEntry[] = [];

    async function scanDir(dirPath: string, currentRelative: string): Promise<void> {
      const items = await fs.readdir(dirPath, { withFileTypes: true });

      for (const item of items) {
        // Skip hidden files and directories
        if (item.name.startsWith('.')) continue;

        const itemPath = path.join(dirPath, item.name);
        const itemRelative = currentRelative ? path.join(currentRelative, item.name) : item.name;

        if (item.isDirectory()) {
          entries.push({
            name: item.name,
            path: itemRelative,
            type: 'directory'
          });

          if (recursive) {
            await scanDir(itemPath, itemRelative);
          }
        } else if (item.isFile()) {
          const ext = path.extname(item.name).toLowerCase();

          // Filter by extensions if specified
          if (extensions.length > 0 && !extensions.includes(ext)) continue;

          entries.push({
            name: item.name,
            path: itemRelative,
            type: 'file',
            extension: ext
          });
        }
      }
    }

    await scanDir(targetPath, relativePath);

    // Sort: directories first, then files, both alphabetically
    entries.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    return {
      success: true,
      message: `Found ${entries.length} items`,
      path: targetPath,
      operation: "list-directory",
      changed: false,
      entries,
      details: {
        directories: entries.filter(e => e.type === 'directory').length,
        files: entries.filter(e => e.type === 'file').length,
        recursive,
        extensions
      }
    };
  } catch (error) {
    throw handleFsError(error, 'list directory');
  }
}

function formatResult(result: NoteOperationResult & { entries: FileEntry[] }): string {
  const parts: string[] = [];

  parts.push(result.message);
  parts.push(`Path: ${result.path}`);
  parts.push(`Directories: ${result.details?.directories}, Files: ${result.details?.files}`);

  if (result.entries.length === 0) {
    parts.push('\n(empty directory)');
    return parts.join('\n');
  }

  parts.push('\n--- Contents ---');

  for (const entry of result.entries) {
    const prefix = entry.type === 'directory' ? '📁 ' : '📄 ';
    parts.push(`${prefix}${entry.path}`);
  }

  return parts.join('\n');
}

export function createListDirectoryTool(vaults: Map<string, string>) {
  return createTool<ListDirectoryInput>({
    name: "list-directory",
    description: `List files and directories in a vault path.

Use this to explore the vault structure before creating or moving notes.

Examples:
- List root: { "vault": "vault1" }
- List subfolder: { "vault": "vault1", "path": "journal/2024" }
- Recursive: { "vault": "vault1", "recursive": true }
- All files: { "vault": "vault1", "extensions": [] }`,
    schema,
    handler: async (args, vaultPath) => {
      const result = await listDirectory(
        vaultPath,
        args.path || "",
        args.recursive || false,
        args.extensions || [".md"]
      );
      return { content: [{ type: "text", text: formatResult(result) }] };
    }
  }, vaults);
}
