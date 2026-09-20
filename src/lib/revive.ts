/**
 * Detecting a model that stopped mid-task and picking it back up.
 *
 * Ox (and sometimes others) will halt for reasons the app never imposed —
 * an internal token budget, a habit of writing "say continue", or just
 * deciding the work so far looks finished. The user then has to type
 * resume every time.
 *
 * This is not a rebuild. The transcript already holds every tool result
 * and every file that landed. A revive appends one short "keep going"
 * message and the loop continues. Capped, because nagging a model that
 * has genuinely finished wastes a round and usually produces a worse
 * answer — and restarting the same work ten times is exactly what this
 * exists to avoid.
 */

export const MAX_AUTO_REVIVES = 2;

export type PrematureStopReason =
  | "limit_language"
  | "empty_after_work"
  | "mid_sentence"
  | "unfinished_plan"
  | "dangling_next"
  | "provider_abort"
  | "round_cap"
  | "thinking_cut"
  | "loop_breaker";

export interface PrematureStopInput {
  /** The whole reply so far, including earlier rounds. */
  content: string;
  /** Prose from this round only — empty when the model just… stopped. */
  roundContent: string;
  /**
   * Chain of thought for this reply. Ox often writes the "I have to stop"
   * excuse here and never puts it in the visible answer, so a detector that
   * only reads `content` misses the most common inner-limit abort.
   */
  reasoning?: string;
  toolRounds: number;
  toolsUsed: string[];
  /** null when there is no plan. */
  planComplete: boolean | null;
  planBlocked: boolean;
  finishReason: string;
}

const LIMIT_LANGUAGE =
  /\b(?:hit|reached|hitting|ran out of) (?:the |my |an )?(?:token |context |output |length |character |internal )?limit\b/i;
/** Hard limit language — names a limit or an abort outright. Always counts.
 * "I have to stop" is an explicit stop declaration, not a casual sign-off. */
const LIMIT_LANGUAGE_EXTRA =
  /\b(?:context window|token budget|max tokens|output limit|inner limit|internal limit|due to (?:length|limits?)|I(?:(?:'ll| will| must)| have) to stop|I cannot continue)\b/i;
/**
 * Casual sign-offs, not limit language. "Pausing here for now — say continue
 * if you want more" is how a model politely ends a FINISHED answer; flagging
 * it as an abort produced the false "inner limit" banner on replies that had
 * simply concluded. A soft phrase only counts when the reply is ALSO
 * truncated (ends mid-word) or the round is nearly empty — the real Ox shape.
 */
const SOFT_STOP_LANGUAGE =
  /\b(?:(?:I(?:'m| am) )?(?:stopping|pausing) (?:here|for now)|stop(?:ping)? here(?: for now)?|continue in (?:the )?(?:next|another) (?:message|reply|turn)|to be continued|say (?:\"|')?(?:continue|resume)|type (?:\"|')?(?:continue|resume)|ask me to (?:continue|resume)|pick this up|please (?:send|type) (?:continue|resume))\b/i;

const COMPLETION =
  /\b(?:all (?:done|finished)|task is complete|everything (?:is |looks )?(?:done|working|finished)|here(?:'s| is) what I (?:changed|did|built|fixed)|verified (?:it |that )?(?:works|passed))\b/i;

/**
 * Prose promising imminent action, followed by a stop with no tool call.
 *
 * The original three branches only caught "now" + a short verb list, so the
 * loop's most common shapes — "let me read main.cpp", "let me make three
 * edits", "I'll start by checking the decoder", all without "now" — sailed
 * through and the user hand-pumped "continue" forever, three narrations per
 * pump (one plan nudge, two revives, all generic). Closed verb list on
 * purpose: presentation verbs (explain, show, tell) and idioms ("let me
 * know", "make sure") must never read as intent, or ordinary answers revive.
 */
const DANGLING_NEXT =
  /\b(?:I(?:'ll| will) (?:now |first )?(?:write|edit|fix|run|test|implement|create|continue with|keep going)|next I(?:'ll| will)|let me now (?:write|edit|fix|run|implement)|(?:let me|I(?:'ll| will| need to| have to| must))(?: (?:now|first|just|quickly|start by|begin by))? (?:read(?:ing)?|check(?:ing)?|look(?:ing)?(?: at| through| into)?|inspect(?:ing)?|examin(?:e|ing)|make(?! (?:sure|sense|certain)\b| a notes?\b)|taking? a look|updat(?:e|ing)|add(?:ing)?|remov(?:e|ing)|delet(?:e|ing)|refactor(?:ing)?|rewrit(?:e|ing)|renam(?:e|ing)|mov(?:e|ing)|search(?:ing)?|verif(?:y|ying)|writ(?:e|ing)|edit(?:ing)?|fix(?:ing)?|run(?:ning)?|test(?:ing)?|implement(?:ing)?|creat(?:e|ing)|start(?:ing)?|continu(?:e|ing)|try(?:ing)?|appl(?:y|ying)|build(?:ing)?|compil(?:e|ing)|open(?:ing)?|load(?:ing)?))\b/i;

/** Does this prose promise imminent action ("let me read…", "I'll fix…")? */
export function describesImminentAction(text: string): boolean {
  return DANGLING_NEXT.test(tailOf(text ?? ""));
}

const PROVIDER_ABORT =
  /^(?:content_filter|content-filter|model_error|error|timeout|max_tokens)$/i;

function tailOf(text: string, n = 1800): string {
  const t = text.trim();
  return t.length <= n ? t : t.slice(-n);
}

function lastParagraph(text: string): string {
  const parts = text.trim().split(/\n\n+/);
  return (parts[parts.length - 1] ?? "").trim();
}

/** A closing question aimed at the user — they have to answer, not us. */
function looksLikeUserQuestion(text: string): boolean {
  const last = lastParagraph(text);
  return last.length > 0 && last.length < 400 && /\?\s*$/.test(last);
}

function endsMidSentence(text: string): boolean {
  const t = text.trim();
  if (t.length < 80) return false;
  if (/```\s*$/.test(t)) return false;
  const stripped = t.replace(/["'`)\]]+$/u, "").trimEnd();
  const ch = stripped.slice(-1);
  if (/[.!?:]/.test(ch)) return false;
  if (/\n#{1,6}\s+\S+$/.test(stripped)) return false;
  return true;
}

function hasLimitLanguage(text: string): boolean {
  return (
    LIMIT_LANGUAGE.test(text) ||
    LIMIT_LANGUAGE_EXTRA.test(text) ||
    SOFT_STOP_LANGUAGE.test(text)
  );
}

/**
 * Why this stop looks unfinished, or null when we should leave it alone.
 *
 * Conservative on purpose. A false continue on a finished answer costs a
 * full round of padding. A missed one still has Resume.
 */
export function detectPrematureStop(
  input: PrematureStopInput
): PrematureStopReason | null {
  const round = (input.roundContent ?? "").trim();
  const full = (input.content ?? "").trim();
  const thinking = (input.reasoning ?? "").trim();
  const tail = tailOf(round || full);

  if (looksLikeUserQuestion(tail)) return null;

  // A finished answer is never an inner-limit stop, whatever its
  // deliberation muttered on the way: "all done — say continue for
  // tweaks" is an invitation, and a "pausing here" inside the thought
  // box is routine mid-deliberation, not an abort. The excuse only
  // counts when the round itself is (almost) empty — Ox's real shape —
  // or when the visible answer claims a limit with no completion
  // language alongside it.
  const answered = COMPLETION.test(tail) && input.planComplete !== false;
  if (!answered) {
    if (LIMIT_LANGUAGE.test(tail) || LIMIT_LANGUAGE_EXTRA.test(tail)) {
      return "limit_language";
    }
    // A soft sign-off alone never flags a substantial reply — "pausing here
    // for now" is how a finished answer politely ends. It counts only when
    // the reply is genuinely truncated (mid-word cut) or nearly empty.
    if (
      SOFT_STOP_LANGUAGE.test(tail) &&
      (endsMidSentence(full) || round.length < 40)
    ) {
      return "limit_language";
    }
    if (round.length < 40 && hasLimitLanguage(thinking)) {
      return "limit_language";
    }
  }

  if (
    input.toolRounds >= 1 &&
    PROVIDER_ABORT.test(input.finishReason ?? "")
  ) {
    return "provider_abort";
  }

  // Narrated intent outranks the unfinished plan: "your plan has steps left"
  // tells the model nothing it doesn't know, while "you described the next
  // action instead of doing it" names the failure. Fires on a planned run
  // even before the first tool call — but never on plan-less chat, where
  // "let me check…" is just how an answer begins.
  if (
    !COMPLETION.test(tail) &&
    (input.toolRounds >= 1 || input.planComplete === false) &&
    DANGLING_NEXT.test(tail)
  ) {
    return "dangling_next";
  }

  if (input.planComplete === false && !input.planBlocked) {
    return "unfinished_plan";
  }

  // Thinking ran, then nothing useful was written. Ox does this when an
  // inner budget kills the round: finish_reason is often just "stop",
  // there are no tools yet, and the excuse lives only in the thought box.
  if (input.toolRounds === 0) {
    if (
      thinking.length >= 200 &&
      (round || full).length === 0 &&
      !COMPLETION.test(thinking)
    ) {
      return "thinking_cut";
    }
    if (
      thinking.length >= 200 &&
      endsMidSentence(round || full) &&
      (round || full).length < 120 &&
      !COMPLETION.test(round || full)
    ) {
      return "thinking_cut";
    }
    return null;
  }

  if (COMPLETION.test(tail) && input.planComplete !== false) return null;

  if (round.length < 40 && !COMPLETION.test(full)) return "empty_after_work";

  if (endsMidSentence(round || tail) && !COMPLETION.test(tail)) {
    return "mid_sentence";
  }

  return null;
}

/** One short shove. Repeating the whole brief would invite a rewrite. */
export function reviveInstruction(
  reason: PrematureStopReason,
  hadNoTools = false
): string {
  // A stop on a tool-less round is harness-caused, not defiance: the request
  // was rejected and retried stripped, so no call was possible. Say so, or
  // the shove reads as blame for something the model couldn't do — and the
  // model "fixes" it by narrating harder.
  const stripped =
    "The last round ran without tools (the request was rejected and retried stripped), " +
    "so nothing could be called then. Tools are offered again on the next round. ";
  if (reason === "dangling_next") {
    return (
      (hadNoTools ? stripped : "") +
      `You described the next action and then stopped instead of doing it. ` +
      `Do not narrate, plan aloud, or repeat what you just said — call the tool ` +
      `in this response. Everything above is still valid: continue from exactly ` +
      `where you left off, no redo. If something is genuinely blocked, mark it ` +
      `blocked and tell the user why.`
    );
  }
  const why =
    reason === "limit_language"
      ? "you said you had to stop (a limit, or asking the user to say continue)"
      : reason === "empty_after_work"
        ? "you called tools and then produced no closing answer"
        : reason === "mid_sentence"
          ? "you stopped mid-sentence"
          : reason === "unfinished_plan"
            ? "your plan still has unfinished steps"
            : reason === "round_cap"
              ? "this reply used every tool round it was allowed; work in bigger batches from here (read_files / edit_files / write_files in one call each) instead of one file per call"
              : "the provider ended the round before the task was finished";

  return (
    (hadNoTools ? stripped : "") +
    `You stopped before the task was finished — ${why}. ` +
    `This is not a new request. Everything above is still valid: do not ` +
    `redo work that already landed, do not rewrite files that are already ` +
    `on disk, do not restart the plan. Continue from exactly where you ` +
    `left off. If something is genuinely blocked, mark it blocked and ` +
    `tell the user why.`
  );
}

/** Banner on a reply that stopped mid-task after auto-revives ran out. */
export function prematureStopNotice(reason: PrematureStopReason): string {
  if (reason === "limit_language" || reason === "thinking_cut") {
    return "The model stopped on an inner limit before it finished";
  }
  if (reason === "unfinished_plan") {
    return "The model stopped with steps still left on the plan";
  }
  if (reason === "round_cap") {
    return "The reply used every tool round it was allowed — Resume to carry on";
  }
  if (reason === "loop_breaker") {
    return "The same tool call failed three times running — Resume to steer it another way";
  }
  if (reason === "dangling_next") {
    return "The model kept describing its next action instead of doing it";
  }
  return "The model stopped mid-task before it finished";
}
