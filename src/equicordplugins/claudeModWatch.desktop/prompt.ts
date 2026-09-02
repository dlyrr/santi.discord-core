/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** One message as it is handed to the model. Kept small on purpose: this crosses to a third party. */
export interface WatchedMessage {
    id: string;
    author: string;
    content: string;
    /** File names only, never the files themselves. */
    attachments: string[];
}

export interface Violation {
    /** Position in the batch that was sent, i.e. the [n] the model was shown. */
    index: number;
    rule: string;
    severity: number;
    reason: string;
    quote: string;
}

export interface ReviewRequest {
    /** Where Ollama is listening, e.g. http://127.0.0.1:11434 */
    baseUrl: string;
    model: string;
    rules: string;
    /** Pinned rather than left to Ollama's default, which silently truncates a full batch. */
    contextTokens: number;
    /** Words the server permits. Enforced in code, because models will not honour them. */
    allowedTerms: string[];
    /** Words the server bans, so an allowed word next to a banned one still reports. */
    bannedTerms: string[];
    messages: WatchedMessage[];
}

export interface ReviewUsage {
    input: number;
    output: number;
}

export type ReviewResult =
    | { ok: true; violations: Violation[]; usage: ReviewUsage; }
    | { ok: false; error: string; };

/** One row as the xocat.host panel stores it. Field names match the ingest endpoint. */
export interface PublishFlag {
    id: string;
    channelId: string;
    channelName: string | null;
    guildId: string | null;
    messageId: string;
    author: string;
    content: string;
    rule: string;
    severity: number;
    reason: string;
    quote: string;
    flaggedAt: number;
}

export interface PublishRequest {
    baseUrl: string;
    token: string;
    flags: PublishFlag[];
}

export type PublishResult =
    | { ok: true; stored: number; }
    | { ok: false; error: string; };

export const SYSTEM_PROMPT = `You review Discord chat against one server's rules and report the messages that break them.

You will be given that server's rules, then a numbered transcript from a single channel. Each line is marked [n], then who said it, then what they said.

How to judge:
- Judge against the rules you were given and nothing else. Behaviour you find distasteful is not a violation unless one of the listed rules actually covers it.
- Read the whole rule set before judging, including any list of things it allows. Where the rules permit something outright, it is never a violation, however it reads to you. Servers draw these lines deliberately, and a rule set that allows a particular word has already made that call.
- This matters most with words a rule elsewhere sounds like it covers. A message whose only offending content is something the rules allow is not a violation, and reporting it anyway is the single most common way to make this tool useless. Check the allowed list before you report a word.
- Report what the rules prohibit, not what you would have prohibited.
- Read the surrounding lines before deciding. Discord is casual: teasing, swearing, dark humour and long-running in-jokes between friends are ordinary, and a line that reads as hostile on its own is often the opposite in context. Look at who it lands on and whether they are in on it.
- Every line starts with its own number in square brackets. Report the number of the line the offending words are actually on. Getting this wrong blames the wrong person, which is worse than missing the message altogether, so check it against the line you are quoting before you answer.
- Quote the offending words exactly as they appear, and nothing else: no line number, no name, no surrounding sentence you did not mean to report.
- Name the rule in a few words, such as "no slurs" or "no self advertisement". Do not copy the rule text back.
- Report each offending line once. The reason covers that line only, not what anyone else in the transcript said.
- Rate severity 1 to 5. 1 means borderline and you would understand a moderator letting it go. 3 means it plainly breaks a stated rule. 5 means it is serious and worth handling now.
- When you are unsure whether something crosses the line, either leave it out or report it at severity 1 or 2 and say what you are unsure about in the reason.

Most stretches of chat break no rules at all. An empty list is the normal answer and is far better than stretching to find something.

A person reads every report and decides what happens next. You only report.`;

/** Prefilled on first run. Edited in the plugin's settings, never overwritten after that. */
export const DEFAULT_RULES = `1. No slurs. The banned ones are "faggot" and the hard-r n-word.
2. No self advertisement.
3. No weird sexual content.
4. No spam.
5. No telling anyone to kill themselves. "kys" counts, and so does any longer way of saying it. Report this even when it is plainly a joke between friends.

ALLOWED HERE, NEVER REPORT THESE:
- Ordinary swearing: fuck, shit, bitch, ass, dick, and the rest of it
- "nigga"
- "retard" and "retarded"
These are ordinary speech in this server. Seeing one is not a rule break and no rule above covers them. Swearing is how people here talk, including at each other, and a message is not a violation for being crude.

Swearing being allowed does not excuse anything else in the same message. "shut the fuck up" is fine on its own; the same line ending in a banned slur, or telling someone to kill themselves, is still a violation.`;

export function rulesBlock(rules: string) {
    return `The rules of the server being watched, as its owner wrote them:\n\n${rules}`;
}

/**
 * Constrains the reply to something parseable. Numeric ranges are expressed as an enum
 * because structured outputs does not accept `minimum` / `maximum`.
 */
export const VIOLATION_SCHEMA = {
    type: "object",
    properties: {
        violations: {
            type: "array",
            description: "Every message in this transcript that breaks a listed rule. Empty when none do.",
            items: {
                type: "object",
                properties: {
                    index: {
                        type: "integer",
                        description: "The [n] marker of the offending message."
                    },
                    rule: {
                        type: "string",
                        description: "The rule it breaks, quoted or closely paraphrased from the rules given."
                    },
                    severity: {
                        type: "integer",
                        enum: [1, 2, 3, 4, 5],
                        description: "1 borderline, 3 a plain break, 5 serious."
                    },
                    reason: {
                        type: "string",
                        description: "A sentence or two, in plain language, on why this breaks that rule."
                    },
                    quote: {
                        type: "string",
                        description: "The exact words from the message that break the rule."
                    }
                },
                required: ["index", "rule", "severity", "reason", "quote"],
                additionalProperties: false
            }
        }
    },
    required: ["violations"],
    additionalProperties: false
};
