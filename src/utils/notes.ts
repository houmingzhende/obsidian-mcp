import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

/**
 * Parsed representation of a note
 */
export interface ParsedNote {
  /** Frontmatter metadata as a plain object */
  frontmatter: Record<string, any>;
  /** The note content (excluding frontmatter) */
  content: string;
  /** Whether the note has a frontmatter block */
  hasFrontmatter: boolean;
  /** Raw frontmatter string (including --- delimiters) */
  rawFrontmatter?: string;
}

/**
 * Represents a heading/section in a note
 */
export interface NoteHeading {
  /** Heading level (1-6) */
  level: number;
  /** Heading text */
  text: string;
  /** Line number where the heading starts (1-indexed) */
  line: number;
  /** Character offset in the content */
  offset: number;
}

/**
 * Represents a section in a note (heading + content until next heading)
 */
export interface NoteSection {
  /** The heading that starts this section (null for content before first heading) */
  heading: NoteHeading | null;
  /** Content of the section (including the heading line if present) */
  content: string;
  /** Start line number (1-indexed) */
  startLine: number;
  /** End line number (1-indexed, inclusive) */
  endLine: number;
}

/**
 * Result of a note operation
 */
export interface NoteOperationResult {
  success: boolean;
  message: string;
  path?: string;
  operation?: string;
  changed?: boolean;
  warnings?: string[];
  details?: Record<string, any>;
}

/**
 * Options for section operations
 */
export interface SectionOptions {
  /** Include the heading line in the section content */
  includeHeading?: boolean;
}

/**
 * Parses a note's content into frontmatter and body
 */
export function parseNote(content: string): ParsedNote {
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return {
      frontmatter: {},
      content: content,
      hasFrontmatter: false
    };
  }

  try {
    const frontmatter = parseYaml(match[1]);
    return {
      frontmatter: frontmatter || {},
      content: match[2],
      hasFrontmatter: true,
      rawFrontmatter: match[0]
    };
  } catch (error) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid frontmatter YAML format: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Combines frontmatter and content back into a note
 */
export function stringifyNote(parsed: ParsedNote): string {
  if (!parsed.hasFrontmatter || Object.keys(parsed.frontmatter).length === 0) {
    return parsed.content;
  }

  const frontmatterStr = stringifyYaml(parsed.frontmatter, {
    lineWidth: 0, // Don't wrap lines
    defaultStringType: 'PLAIN',
    defaultKeyType: 'PLAIN',
  }).trim();
  return `---\n${frontmatterStr}\n---\n\n${parsed.content.trim()}`;
}

/**
 * Extracts all headings from a note's content
 */
export function extractHeadings(content: string): NoteHeading[] {
  const headings: NoteHeading[] = [];
  const lines = content.split('\n');
  let offset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      headings.push({
        level: match[1].length,
        text: match[2].trim(),
        line: i + 1, // 1-indexed
        offset: offset
      });
    }
    offset += line.length + 1; // +1 for newline
  }

  return headings;
}

/**
 * Splits a note's content into sections based on headings
 */
export function splitSections(content: string): NoteSection[] {
  const sections: NoteSection[] = [];
  const lines = content.split('\n');
  const headings = extractHeadings(content);

  if (headings.length === 0) {
    // No headings, entire content is one section
    return [{
      heading: null,
      content: content,
      startLine: 1,
      endLine: lines.length
    }];
  }

  // Add section before first heading if there's content
  const firstHeadingLine = headings[0].line;
  if (firstHeadingLine > 1) {
    const preContent = lines.slice(0, firstHeadingLine - 1).join('\n');
    if (preContent.trim()) {
      sections.push({
        heading: null,
        content: preContent,
        startLine: 1,
        endLine: firstHeadingLine - 1
      });
    }
  }

  // Process each heading
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    const nextHeading = headings[i + 1];

    const startLine = heading.line;
    const endLine = nextHeading ? nextHeading.line - 1 : lines.length;

    const sectionLines = lines.slice(startLine - 1, endLine);
    sections.push({
      heading,
      content: sectionLines.join('\n'),
      startLine,
      endLine
    });
  }

  return sections;
}

/**
 * Finds a section by heading text (case-insensitive, supports partial match)
 */
export function findSection(content: string, headingText: string, exact = false): NoteSection | null {
  const sections = splitSections(content);
  const normalizedSearch = headingText.toLowerCase().replace(/^#+\s*/, '');

  for (const section of sections) {
    if (!section.heading) continue;

    const normalizedHeading = section.heading.text.toLowerCase();
    if (exact) {
      if (normalizedHeading === normalizedSearch) {
        return section;
      }
    } else {
      if (normalizedHeading.includes(normalizedSearch) || normalizedSearch.includes(normalizedHeading)) {
        return section;
      }
    }
  }

  return null;
}

/**
 * Replaces a section in the content
 */
export function replaceSection(
  content: string,
  section: NoteSection,
  newContent: string,
  options: SectionOptions = {}
): string {
  const lines = content.split('\n');

  // Determine which lines to replace
  const startIdx = section.startLine - 1; // Convert to 0-indexed
  const endIdx = section.endLine; // endLine is inclusive, slice end is exclusive

  // Replace the section lines
  const newLines = [
    ...lines.slice(0, startIdx),
    newContent,
    ...lines.slice(endIdx)
  ];

  return newLines.join('\n');
}

/**
 * Inserts content before or after a section
 */
export function insertAtSection(
  content: string,
  section: NoteSection,
  newContent: string,
  position: 'before' | 'after'
): string {
  const lines = content.split('\n');

  if (position === 'before') {
    const insertIdx = section.startLine - 1;
    lines.splice(insertIdx, 0, newContent);
  } else {
    const insertIdx = section.endLine;
    lines.splice(insertIdx, 0, '', newContent);
  }

  return lines.join('\n');
}

/**
 * Finds text in content and returns context around it
 */
export function findTextWithContext(
  content: string,
  searchText: string,
  contextLines: number = 5
): { line: number; context: string; match: string } | null {
  const lines = content.split('\n');
  const searchLower = searchText.toLowerCase();

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(searchLower)) {
      const start = Math.max(0, i - contextLines);
      const end = Math.min(lines.length, i + contextLines + 1);
      return {
        line: i + 1, // 1-indexed
        context: lines.slice(start, end).join('\n'),
        match: lines[i]
      };
    }
  }

  return null;
}

/**
 * Patches content by replacing old text with new text
 * Returns null if old text not found or not unique (unless replaceAll is true)
 */
export function patchContent(
  content: string,
  oldText: string,
  newText: string,
  options: { replaceAll?: boolean; requireUnique?: boolean } = {}
): { content: string; count: number } | null {
  const { replaceAll = false, requireUnique = true } = options;

  // Count occurrences
  const occurrences = (content.match(new RegExp(escapeRegex(oldText), 'g')) || []).length;

  if (occurrences === 0) {
    return null;
  }

  if (requireUnique && occurrences > 1 && !replaceAll) {
    return null;
  }

  if (replaceAll) {
    return {
      content: content.split(oldText).join(newText),
      count: occurrences
    };
  }

  // Single replacement
  const idx = content.indexOf(oldText);
  if (idx === -1) {
    return null;
  }

  return {
    content: content.slice(0, idx) + newText + content.slice(idx + oldText.length),
    count: 1
  };
}

/**
 * Escapes special regex characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Deep merges two frontmatter objects
 */
export function mergeFrontmatter(
  existing: Record<string, any>,
  updates: Record<string, any>,
  options: { arrays?: 'replace' | 'merge' | 'append' } = {}
): Record<string, any> {
  const { arrays = 'merge' } = options;
  const result = { ...existing };

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;

    if (value === null) {
      // null means remove the key
      delete result[key];
      continue;
    }

    if (Array.isArray(value) && Array.isArray(result[key])) {
      switch (arrays) {
        case 'replace':
          result[key] = value;
          break;
        case 'append':
          result[key] = [...result[key], ...value];
          break;
        case 'merge':
        default:
          // Merge unique values
          result[key] = [...new Set([...result[key], ...value])];
          break;
      }
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value) &&
               typeof result[key] === 'object' && result[key] !== null && !Array.isArray(result[key])) {
      // Deep merge objects
      result[key] = mergeFrontmatter(result[key], value, options);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Removes specified keys from frontmatter
 */
export function removeFrontmatterKeys(
  frontmatter: Record<string, any>,
  keys: string[]
): { frontmatter: Record<string, any>; removed: string[]; notFound: string[] } {
  const result = { ...frontmatter };
  const removed: string[] = [];
  const notFound: string[] = [];

  for (const key of keys) {
    if (key in result) {
      delete result[key];
      removed.push(key);
    } else {
      notFound.push(key);
    }
  }

  return { frontmatter: result, removed, notFound };
}
