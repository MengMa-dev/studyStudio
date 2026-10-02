import { ensureHeadingMarks, normalizeHeading } from "./normalize.js";
import type { ApplyPatchInput, ApplyPatchResult, PatchOp } from "./types.js";

const SUGGESTION_HEADING = "## 整理建议";

type Section = {
  heading: string; // full line including ##
  start: number; // index of heading line in `lines`
  end: number; // exclusive index of next heading or lines.length
};

function splitSections(markdown: string): { preamble: string[]; sections: Section[]; lines: string[] } {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const sections: Section[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,6}\s+\S/.test(lines[i]!)) {
      sections.push({ heading: lines[i]!, start: i, end: lines.length });
    }
  }
  for (let i = 0; i < sections.length - 1; i++) {
    sections[i]!.end = sections[i + 1]!.start;
  }
  const preamble = sections.length ? lines.slice(0, sections[0]!.start) : lines.slice();
  return { preamble, sections, lines };
}

function sectionBody(lines: string[], section: Section): string {
  return lines
    .slice(section.start + 1, section.end)
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}

function rebuild(preamble: string[], sections: Array<{ heading: string; body: string }>): string {
  const parts: string[] = [];
  const pre = preamble.join("\n").replace(/\n+$/g, "");
  if (pre) parts.push(pre);
  for (const s of sections) {
    const body = s.body.replace(/^\n+|\n+$/g, "");
    parts.push(body ? `${s.heading}\n\n${body}` : s.heading);
  }
  return (
    parts
      .join("\n\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim() + (parts.length ? "\n" : "")
  );
}

function toEditable(markdown: string): { preamble: string[]; sections: Array<{ heading: string; body: string }> } {
  const { preamble, sections, lines } = splitSections(markdown);
  return {
    preamble,
    sections: sections.map((s) => ({ heading: s.heading, body: sectionBody(lines, s) }))
  };
}

function appendSuggestion(body: string, suggestionMarkdown: string): string {
  const editable = toEditable(body);
  const existing = editable.sections.find((s) => normalizeHeading(s.heading) === normalizeHeading(SUGGESTION_HEADING));
  const block = suggestionMarkdown.trim();
  if (existing) {
    existing.body = existing.body.trim() ? `${existing.body.trim()}\n\n${block}` : block;
  } else {
    editable.sections.push({ heading: SUGGESTION_HEADING, body: block });
  }
  return rebuild(editable.preamble, editable.sections);
}

function formatOpAsSuggestion(op: PatchOp): string {
  if (op.op === "append_to_section") {
    return `### 追加到 ${ensureHeadingMarks(op.section)}\n\n${op.markdown.trim()}`;
  }
  if (op.op === "add_section") {
    return `${ensureHeadingMarks(op.heading)}\n\n${op.markdown.trim()}`;
  }
  return `### 替换 ${ensureHeadingMarks(op.section)}\n\n${op.markdown.trim()}`;
}

/**
 * ⑥ Patch applicator.
 * - append_to_section / add_section / replace_section
 * - missing heading → degrade to end-of-doc add_section
 * - replace_section archives previous body
 * - user_edited → do not mutate body; append under「整理建议」
 */
export function applyPatchOps(input: ApplyPatchInput): ApplyPatchResult {
  const replaced_sections: ApplyPatchResult["replaced_sections"] = [];
  const degraded_ops: ApplyPatchResult["degraded_ops"] = [];
  let patch_count = input.patch_count ?? 0;

  if (!input.ops.length) {
    return {
      body_markdown: input.body_markdown,
      replaced_sections,
      degraded_ops,
      wrote_suggestion: false,
      patch_count
    };
  }

  if (input.user_edited) {
    let body = input.body_markdown;
    for (const op of input.ops) {
      body = appendSuggestion(body, formatOpAsSuggestion(op));
    }
    return {
      body_markdown: body,
      replaced_sections,
      degraded_ops,
      wrote_suggestion: true,
      patch_count: patch_count + 1
    };
  }

  const editable = toEditable(input.body_markdown);
  let changed = false;

  for (const op of input.ops) {
    if (op.op === "append_to_section") {
      const target = editable.sections.find((s) => normalizeHeading(s.heading) === normalizeHeading(op.section));
      if (!target) {
        const heading = ensureHeadingMarks(op.section);
        editable.sections.push({ heading, body: op.markdown.trim() });
        degraded_ops.push({ original: op, heading });
        changed = true;
        continue;
      }
      target.body = target.body.trim() ? `${target.body.trim()}\n\n${op.markdown.trim()}` : op.markdown.trim();
      changed = true;
      continue;
    }

    if (op.op === "add_section") {
      const heading = ensureHeadingMarks(op.heading);
      const newSec = { heading, body: op.markdown.trim() };
      if (!op.after || !op.after.trim()) {
        editable.sections.push(newSec);
        changed = true;
        continue;
      }
      const afterIdx = editable.sections.findIndex((s) => normalizeHeading(s.heading) === normalizeHeading(op.after));
      if (afterIdx < 0) {
        editable.sections.push(newSec);
        degraded_ops.push({ original: op, heading });
        changed = true;
        continue;
      }
      editable.sections.splice(afterIdx + 1, 0, newSec);
      changed = true;
      continue;
    }

    if (op.op === "replace_section") {
      const target = editable.sections.find((s) => normalizeHeading(s.heading) === normalizeHeading(op.section));
      if (!target) {
        const heading = ensureHeadingMarks(op.section);
        editable.sections.push({ heading, body: op.markdown.trim() });
        degraded_ops.push({ original: op, heading });
        changed = true;
        continue;
      }
      replaced_sections.push({ section: target.heading, previous_markdown: target.body });
      target.body = op.markdown.trim();
      changed = true;
    }
  }

  if (changed) patch_count += 1;
  return {
    body_markdown: rebuild(editable.preamble, editable.sections),
    replaced_sections,
    degraded_ops,
    wrote_suggestion: false,
    patch_count
  };
}

export { SUGGESTION_HEADING };
