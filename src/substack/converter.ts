/**
 * Markdown to Substack JSON converter
 * Adapted from substack-mcp-plus Python implementation
 */

import {
  TextContent,
  InlineContent,
  FootnoteBlock,
  ParagraphBlock,
  HeaderBlock,
  BulletListBlock,
  OrderedListBlock,
  CodeBlock,
  BlockquoteBlock,
  ImageBlock,
  HorizontalRuleBlock,
  SubstackBlock,
  SubstackDocument
} from "./types";

// Escape sequences for protected characters
const ESCAPED_ASTERISK = "\x00ESCAPED_ASTERISK\x00";
const ESCAPED_BRACKET_OPEN = "\x00ESCAPED_BRACKET_OPEN\x00";
const ESCAPED_BRACKET_CLOSE = "\x00ESCAPED_BRACKET_CLOSE\x00";

// Footnote definition line: "[^id]: text"
const FOOTNOTE_DEFINITION = /^\[\^([^\]\s]+)\]:[ \t]?(.*)$/;
// Indented continuation line of a footnote definition
const FOOTNOTE_CONTINUATION = /^( {2,}|\t)\S/;

/**
 * Footnote bookkeeping for a single conversion.
 * Footnotes are numbered in order of first reference, like Obsidian's reading view.
 */
interface FootnoteState {
  definitions: Map<string, string>;
  numbers: Map<string, number>;
  inline: Array<{ number: number; text: string }>;
}

/**
 * Builder class for creating Substack JSON blocks
 */
class BlockBuilder {
  paragraph(content: string | InlineContent[]): ParagraphBlock {
    if (typeof content === "string") {
      return {
        type: "paragraph",
        content: [{ type: "text", text: content }]
      };
    }
    return { type: "paragraph", content };
  }

  hardBreak(): { type: "hardBreak" } {
    return { type: "hardBreak" };
  }

  header(text: string, level: number): HeaderBlock {
    if (level < 1 || level > 6) {
      throw new Error("Header level must be between 1 and 6");
    }

    return {
      type: "heading",
      attrs: { level: level as 1 | 2 | 3 | 4 | 5 | 6 },
      content: [{ type: "text", text }]
    };
  }

  unorderedList(items: InlineContent[][]): BulletListBlock {
    return {
      type: "bulletList",
      content: items.map((itemContent) => ({
        type: "listItem" as const,
        content: [this.paragraph(itemContent)]
      }))
    };
  }

  orderedList(items: InlineContent[][]): OrderedListBlock {
    return {
      type: "orderedList",
      content: items.map((itemContent) => ({
        type: "listItem" as const,
        content: [this.paragraph(itemContent)]
      }))
    };
  }

  codeBlock(code: string, language: string = ""): CodeBlock {
    const block: CodeBlock = {
      type: "codeBlock",
      content: [{ type: "text", text: code }]
    };
    if (language) {
      block.attrs = { language };
    }
    return block;
  }

  blockquote(content: string | InlineContent[]): BlockquoteBlock {
    return {
      type: "blockquote",
      content: [this.paragraph(content)]
    };
  }

  image(src: string, alt: string, title: string = ""): ImageBlock {
    const attrs: ImageBlock["attrs"] = {
      src,
      fullscreen: false
    };
    if (alt) attrs.alt = alt;
    if (title) attrs.title = title;
    return {
      type: "image2",
      attrs
    };
  }

  link(linkText: string, href: string): TextContent {
    return {
      type: "text",
      text: linkText,
      marks: [{ type: "link", attrs: { href } }]
    };
  }

  horizontalRule(): HorizontalRuleBlock {
    return { type: "horizontal_rule" };
  }

  text(
    textContent: string,
    marks?: Array<"strong" | "em" | "code">
  ): TextContent {
    const textObj: TextContent = { type: "text", text: textContent };
    if (marks && marks.length > 0) {
      textObj.marks = marks.map((mark) => ({ type: mark }));
    }
    return textObj;
  }
}

/**
 * Converts Markdown text to Substack JSON block format
 */
export class MarkdownConverter {
  private builder: BlockBuilder;
  private footnotes: FootnoteState | null = null;

  constructor() {
    this.builder = new BlockBuilder();
  }

  /**
   * Convert markdown text to Substack document format
   */
  convert(markdown: string): SubstackDocument {
    this.footnotes = { definitions: new Map(), numbers: new Map(), inline: [] };
    try {
      const body = this.extractFootnoteDefinitions(markdown ?? "");
      const blocks = this.convertToBlocks(body);
      blocks.push(...this.buildFootnoteBlocks());
      return {
        type: "doc",
        content: blocks
      };
    } finally {
      this.footnotes = null;
    }
  }

  /**
   * Remove footnote definitions from the markdown and record them.
   * Supports multi-paragraph definitions via indented continuation lines.
   * Definitions inside fenced code blocks are left untouched.
   */
  private extractFootnoteDefinitions(markdown: string): string {
    const lines = markdown.split("\n");
    const kept: string[] = [];
    let inFence = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const match = inFence ? null : line.match(FOOTNOTE_DEFINITION);

      if (match && match[1] !== undefined) {
        const parts = [match[2] ?? ""];
        while (i + 1 < lines.length) {
          const next = lines[i + 1] ?? "";
          if (FOOTNOTE_CONTINUATION.test(next)) {
            parts.push(next.replace(/^( {1,4}|\t)/, ""));
            i++;
          } else if (
            !next.trim() &&
            FOOTNOTE_CONTINUATION.test(lines[i + 2] ?? "")
          ) {
            parts.push("");
            i++;
          } else {
            break;
          }
        }
        this.footnotes?.definitions.set(match[1], parts.join("\n").trim());
        continue;
      }

      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
      }
      kept.push(line);
    }

    return kept.join("\n");
  }

  private nextFootnoteNumber(): number {
    const state = this.footnotes;
    return state ? state.numbers.size + state.inline.length + 1 : 1;
  }

  private buildFootnoteBlocks(): FootnoteBlock[] {
    const state = this.footnotes;
    if (!state) return [];

    const notes: Array<{ number: number; text: string }> = [...state.inline];
    for (const [id, number] of state.numbers) {
      notes.push({ number, text: state.definitions.get(id) ?? "" });
    }

    return notes
      .sort((a, b) => a.number - b.number)
      .map((note) => ({
        type: "footnote" as const,
        attrs: { number: note.number },
        content: note.text
          .split(/\n\s*\n/)
          .map((para) =>
            this.builder.paragraph(
              this.parseInlineFormatting(para.replace(/\n/g, " ").trim())
            )
          )
      }));
  }

  /**
   * Convert markdown text to Substack JSON blocks
   */
  convertToBlocks(markdown: string): SubstackBlock[] {
    if (!markdown || !markdown.trim()) {
      return [];
    }

    const blocks: SubstackBlock[] = [];
    const lines = markdown.split("\n");
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      if (line === undefined) {
        i++;
        continue;
      }

      // Skip empty lines
      if (!line.trim()) {
        i++;
        continue;
      }

      // Check for code blocks
      if (line.trim().startsWith("```")) {
        const result = this.parseCodeBlock(lines, i);
        if (result.block) {
          blocks.push(result.block);
        }
        i = result.nextIndex;
        continue;
      }

      // Check for headers
      if (line.startsWith("#")) {
        const block = this.parseHeader(line);
        if (block) {
          blocks.push(block);
          i++;
          continue;
        }
      }

      // Check for horizontal rule
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
        blocks.push(this.builder.horizontalRule());
        i++;
        continue;
      }

      // Check for blockquote
      if (line.startsWith(">")) {
        const result = this.parseBlockquote(lines, i);
        if (result.block) {
          blocks.push(result.block);
        }
        i = result.nextIndex;
        continue;
      }

      // Check for lists
      if (/^(\*|-|\+|\d+\.)\s/.test(line.trim())) {
        const result = this.parseList(lines, i);
        if (result.block) {
          blocks.push(result.block);
        }
        i = result.nextIndex;
        continue;
      }

      // Default to paragraph
      const result = this.parseParagraph(lines, i);
      if (result.block) {
        blocks.push(result.block);
      }
      i = result.nextIndex;
    }

    return blocks;
  }

  private parseHeader(line: string): HeaderBlock | null {
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match && match[1] && match[2]) {
      const level = match[1].length;
      const content = match[2].trim();
      return this.builder.header(content, level);
    }
    return null;
  }

  private parseCodeBlock(
    lines: string[],
    start: number
  ): { block: CodeBlock | null; nextIndex: number } {
    const line = lines[start];
    if (!line || !line.trim().startsWith("```")) {
      return { block: null, nextIndex: start + 1 };
    }

    // Extract language if present
    const language = line.trim().slice(3).trim();

    // Find the closing ```
    const codeLines: string[] = [];
    let i = start + 1;
    while (i < lines.length) {
      const currentLine = lines[i];
      if (currentLine !== undefined && currentLine.trim() === "```") {
        const code = codeLines.join("\n");
        return {
          block: this.builder.codeBlock(code, language),
          nextIndex: i + 1
        };
      }
      codeLines.push(currentLine ?? "");
      i++;
    }

    // If no closing found, treat as paragraph
    return { block: null, nextIndex: start + 1 };
  }

  private parseBlockquote(
    lines: string[],
    start: number
  ): { block: BlockquoteBlock | null; nextIndex: number } {
    const quoteLines: string[] = [];
    let i = start;

    while (i < lines.length) {
      const line = lines[i];
      if (!line || !line.trim().startsWith(">")) {
        break;
      }
      const content = line.trim().slice(1).trim();
      quoteLines.push(content);
      i++;
    }

    if (quoteLines.length > 0) {
      const quoteText = quoteLines.join(" ");
      return {
        block: this.builder.blockquote(this.parseInlineFormatting(quoteText)),
        nextIndex: i
      };
    }

    return { block: null, nextIndex: start + 1 };
  }

  private parseList(
    lines: string[],
    start: number
  ): { block: BulletListBlock | OrderedListBlock | null; nextIndex: number } {
    const firstLine = lines[start];
    if (!firstLine) {
      return { block: null, nextIndex: start + 1 };
    }

    // Determine list type
    const isOrdered = /^\d+\.\s/.test(firstLine.trim());

    const items: InlineContent[][] = [];
    let i = start;

    while (i < lines.length) {
      const line = lines[i];
      if (line === undefined) {
        i++;
        continue;
      }

      const trimmedLine = line.trim();
      if (!trimmedLine) {
        // Empty line might end the list
        const nextLine = lines[i + 1];
        if (
          nextLine === undefined ||
          !/^(\*|-|\+|\d+\.)\s/.test(nextLine.trim())
        ) {
          break;
        }
        i++;
        continue;
      }

      // Check if this line is a list item
      let match: RegExpMatchArray | null;
      if (isOrdered) {
        match = trimmedLine.match(/^\d+\.\s+(.+)$/);
      } else {
        match = trimmedLine.match(/^(\*|-|\+)\s+(.+)$/);
      }

      if (match) {
        const content = isOrdered ? match[1] : match[2];
        if (content) {
          // Parse inline formatting for list items
          const parsedContent = this.parseInlineFormatting(content);
          items.push(parsedContent);
        }
        i++;
      } else {
        break;
      }
    }

    if (items.length > 0) {
      if (isOrdered) {
        return { block: this.builder.orderedList(items), nextIndex: i };
      } else {
        return { block: this.builder.unorderedList(items), nextIndex: i };
      }
    }

    return { block: null, nextIndex: start + 1 };
  }

  private parseParagraph(
    lines: string[],
    start: number
  ): { block: ParagraphBlock | ImageBlock | null; nextIndex: number } {
    const paragraphLines: string[] = [];
    let i = start;

    while (i < lines.length) {
      const line = lines[i];
      if (line === undefined) {
        break;
      }

      const trimmedLine = line.trim();

      // Stop at empty lines or special syntax
      if (
        !trimmedLine ||
        line.startsWith("#") ||
        line.startsWith(">") ||
        trimmedLine.startsWith("```") ||
        /^(\*|-|\+|\d+\.)\s/.test(trimmedLine) ||
        /^(-{3,}|\*{3,}|_{3,})$/.test(trimmedLine)
      ) {
        break;
      }

      paragraphLines.push(line);
      i++;
    }

    if (paragraphLines.length > 0) {
      // Check for images first (single line only)
      if (paragraphLines.length === 1 && paragraphLines[0]) {
        const imgMatch = paragraphLines[0]
          .trim()
          .match(/^!\[([^\]]*)\]\(([^\s)]+)(?:\s+"([^"]+)")?\)$/);
        if (imgMatch) {
          const altText = imgMatch[1] ?? "";
          const src = imgMatch[2] ?? "";
          const caption = imgMatch[3] ?? "";
          return {
            block: this.builder.image(src, altText, caption),
            nextIndex: i
          };
        }
      }

      // Parse each line and insert hardBreak between lines
      const content: InlineContent[] = [];
      for (let j = 0; j < paragraphLines.length; j++) {
        const line = paragraphLines[j];
        if (line === undefined) continue;

        const lineContent = this.parseInlineFormatting(line);
        content.push(...lineContent);

        // Add hardBreak between lines (not after the last line)
        if (j < paragraphLines.length - 1) {
          content.push(this.builder.hardBreak());
        }
      }

      return { block: this.builder.paragraph(content), nextIndex: i };
    }

    return { block: null, nextIndex: start + 1 };
  }

  private parseInlineFormatting(text: string): InlineContent[] {
    // Handle escaped characters
    const processedText = text
      .replace(/\\\*/g, ESCAPED_ASTERISK)
      .replace(/\\\[/g, ESCAPED_BRACKET_OPEN)
      .replace(/\\\]/g, ESCAPED_BRACKET_CLOSE);

    const elements: InlineContent[] = [];
    let remaining = processedText;

    const patterns: Array<{ regex: RegExp; type: string }> = [
      { regex: /\[\^([^\]\s]+)\]/, type: "footnote_ref" },
      { regex: /\^\[([^\]]+)\]/, type: "footnote_inline" },
      { regex: /\*\*\*([^*]+)\*\*\*/, type: "bold_italic" },
      { regex: /\*\*([^*]+)\*\*/, type: "bold" },
      { regex: /\*([^*]+)\*/, type: "italic" },
      { regex: /\[([^\]]+)\]\(([^)]+)\)/, type: "link" },
      { regex: /`([^`]+)`/, type: "code" }
    ];

    while (remaining) {
      let earliestPos = remaining.length;
      let nextMatch: RegExpExecArray | null = null;
      let nextType: string | null = null;

      for (const { regex, type } of patterns) {
        const match = regex.exec(remaining);
        if (match && match.index < earliestPos) {
          earliestPos = match.index;
          nextMatch = match;
          nextType = type;
        }
      }

      if (nextMatch && nextType) {
        // Add text before the match
        if (nextMatch.index > 0) {
          const plainText = remaining.slice(0, nextMatch.index);
          elements.push(
            this.restoreEscapedChars({ type: "text", text: plainText })
          );
        }

        // Add the formatted element
        switch (nextType) {
        case "footnote_ref": {
          const id = nextMatch[1] ?? "";
          const state = this.footnotes;
          if (state && state.definitions.has(id)) {
            let number = state.numbers.get(id);
            if (number === undefined) {
              number = this.nextFootnoteNumber();
              state.numbers.set(id, number);
            }
            elements.push({ type: "footnoteAnchor", attrs: { number } });
          } else {
            // Undefined reference: keep the literal text
            elements.push(
              this.restoreEscapedChars({ type: "text", text: nextMatch[0] })
            );
          }
          break;
        }
        case "footnote_inline": {
          const state = this.footnotes;
          if (state) {
            const number = this.nextFootnoteNumber();
            state.inline.push({ number, text: nextMatch[1] ?? "" });
            elements.push({ type: "footnoteAnchor", attrs: { number } });
          } else {
            elements.push(
              this.restoreEscapedChars({ type: "text", text: nextMatch[0] })
            );
          }
          break;
        }
        // Emphasis content is parsed recursively so it can contain
        // links and footnote references
        case "bold_italic":
          elements.push(
            ...this.withMarks(this.parseInlineFormatting(nextMatch[1] ?? ""), [
              "strong",
              "em"
            ])
          );
          break;
        case "bold":
          elements.push(
            ...this.withMarks(this.parseInlineFormatting(nextMatch[1] ?? ""), [
              "strong"
            ])
          );
          break;
        case "italic":
          elements.push(
            ...this.withMarks(this.parseInlineFormatting(nextMatch[1] ?? ""), [
              "em"
            ])
          );
          break;
        case "link":
          elements.push(
            this.restoreEscapedChars(
              this.builder.link(nextMatch[1] ?? "", nextMatch[2] ?? "")
            )
          );
          break;
        case "code":
          elements.push(
            this.restoreEscapedChars(
              this.builder.text(nextMatch[1] ?? "", ["code"])
            )
          );
          break;
        }

        remaining = remaining.slice(nextMatch.index + nextMatch[0].length);
      } else {
        // No more formatting, add the rest as plain text
        elements.push(
          this.restoreEscapedChars({ type: "text", text: remaining })
        );
        break;
      }
    }

    return elements.length > 0 ? elements : [{ type: "text", text: "" }];
  }

  private withMarks(
    elements: InlineContent[],
    marks: Array<"strong" | "em">
  ): InlineContent[] {
    for (const element of elements) {
      if (element.type === "text" && element.text) {
        element.marks = [
          ...(element.marks ?? []),
          ...marks.map((type) => ({ type }))
        ];
      }
    }
    return elements;
  }

  private restoreEscapedChars(element: TextContent): TextContent {
    if (element.text) {
      element.text = element.text
        .replace(new RegExp(ESCAPED_ASTERISK, "g"), "*")
        .replace(new RegExp(ESCAPED_BRACKET_OPEN, "g"), "[")
        .replace(new RegExp(ESCAPED_BRACKET_CLOSE, "g"), "]");
    }
    return element;
  }
}
