/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcMainInvokeEvent } from "electron";

import { PublishRequest, PublishResult, ReviewRequest, ReviewResult, rulesBlock, SYSTEM_PROMPT, Violation, VIOLATION_SCHEMA, WatchedMessage } from "./prompt";

const MAX_MESSAGES = 100;
const MAX_MESSAGE_CHARS = 600;
const MAX_AUTHOR_CHARS = 64;
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_CHARS = 80;
const MAX_RULES_CHARS = 8000;

/**
 * Long, because the first call after the model is evicted pays for loading it into VRAM.
 * On a modest card that load is most of the wait; a warm call comes back in seconds.
 */
const REQUEST_TIMEOUT_MS = 180_000;

const MAX_PUBLISHED_FLAGS = 50;
const PUBLISH_TIMEOUT_MS = 20_000;

const MODEL_TAG = /^[\w./:-]{1,200}$/;

/** The transcript is one message per line, so a message's own line breaks have to go. */
const LINE_BREAK = /\r\n?|\n/g;
const CONTROL_CHARS = new RegExp("[\u0000-\u001F\u007F]", "g");
const EXTRA_SPACE = /\s{2,}/g;

/** Rules keep their line breaks; everything that lands in the transcript does not. */
function clamp(value: unknown, limit: number, keepLineBreaks = false) {
    if (typeof value !== "string") return "";

    const flattened = keepLineBreaks ? value : value.replace(LINE_BREAK, " ");
    const cleaned = flattened.replace(CONTROL_CHARS, keepLineBreaks ? "" : " ").replace(EXTRA_SPACE, " ").trim();

    return cleaned.length > limit ? `${cleaned.slice(0, limit)}…` : cleaned;
}

function describe(message: WatchedMessage, index: number) {
    const author = clamp(message.author, MAX_AUTHOR_CHARS) || "unknown";
    const body = clamp(message.content, MAX_MESSAGE_CHARS);

    const files = (message.attachments ?? [])
        .slice(0, MAX_ATTACHMENTS)
        .map(name => clamp(name, MAX_ATTACHMENT_CHARS))
        .filter(Boolean);

    const parts = [body];
    if (files.length) parts.push(`(attached: ${files.join(", ")})`);

    return `[${index}] ${author}: ${parts.filter(Boolean).join(" ")}`;
}

const QUOTE_PREFIX = /^\s*\[\d+\]\s*[^:]{0,64}:\s*/;

/**
 * Models habitually wrap the quoted words in quote marks of their own, and matching
 * those literally against the message fails every time. Stripping them from both sides
 * of the comparison costs nothing: apostrophes never decide which message a quote is in.
 */
const QUOTE_MARKS = new RegExp("[\"'`‘’“”]", "g");

function normaliseForMatching(value: string) {
    return value.replace(QUOTE_MARKS, "").toLowerCase().replace(EXTRA_SPACE, " ").trim();
}

function normaliseQuote(value: string) {
    // Quote marks come off before the "[n] name:" prefix, or a wrapped prefix survives it.
    return normaliseForMatching(value.replace(QUOTE_MARKS, "").replace(QUOTE_PREFIX, ""));
}

/**
 * Small models routinely report the right quote against the wrong line number, which
 * would pin one person's rule break on whoever happens to sit at that index. The quote
 * is the reliable half of the answer, so it decides: a violation whose quote is not in
 * the message it names gets re-pointed at the message that actually contains it, and is
 * dropped when that is ambiguous. Blaming nobody beats blaming the wrong person.
 */
function anchorToQuotedMessage(violation: Violation, batch: WatchedMessage[]): Violation | null {
    const quote = normaliseQuote(violation.quote);
    if (!quote) return null;

    const claimed = batch[violation.index];
    if (claimed && normaliseForMatching(claimed.content).includes(quote)) return violation;

    const matches = batch
        .map((message, index) => ({ index, content: normaliseForMatching(message.content) }))
        .filter(candidate => candidate.content.includes(quote));

    if (matches.length !== 1) return null;

    return { ...violation, index: matches[0].index };
}

const LANGUAGE_RULE = /slur|profan|swear|curs|vulgar|language|\bword\b|racial|homophob|offensive|crude|inappropriate/i;

const TERM_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/**
 * Word-start matching with a suffix allowance: "fuck" covers "fucking", "retard" covers
 * "retarded", but "ass" does not quietly match "class" or "pass". Plain substring matching
 * here would drop genuine reports whenever a permitted word sat inside an ordinary one,
 * and a filter that silently eats real violations is worse than no filter.
 */
function containsTerm(text: string, term: string) {
    return new RegExp(`\\b${term.replace(TERM_SPECIALS, "\\$&")}\\w*`, "i").test(text);
}

/** True when stripping the permitted words leaves the quote with no words at all. */
function isNothingButAllowedWords(quote: string, allowedTerms: string[]) {
    const stripped = allowedTerms.reduce(
        (text, term) => text.replace(new RegExp(`\\b${term.replace(TERM_SPECIALS, "\\$&")}\\w*`, "gi"), " "),
        quote
    );

    return !/[a-z]/i.test(stripped);
}

/**
 * Every model tested flags the words this server explicitly permits, because every model
 * was trained to. Prompting does not fix it: one called them severity 1 while saying they
 * were allowed, another called them severity 3 while quoting the rule that allows them.
 *
 * So the allow list is enforced here instead of asked for. A slur report whose quote holds
 * a permitted word and no banned one is dropped outright. A permitted word sitting next to
 * a banned one still reports, and a report under any other rule is left alone, so a message
 * that also spams or advertises is unaffected.
 */
function isPermittedWordOnly(violation: Violation, allowedTerms: string[], bannedTerms: string[]) {
    if (!allowedTerms.length) return false;

    const quote = normaliseForMatching(violation.quote);

    // A banned word anywhere in the quote outranks everything: "fuck you faggot" reports.
    if (bannedTerms.some(term => containsTerm(quote, term))) return false;
    if (!allowedTerms.some(term => containsTerm(quote, term))) return false;

    // Quoting the swear and nothing else means the word itself was the whole complaint.
    if (isNothingButAllowedWords(quote, allowedTerms)) return true;

    // Otherwise only drop it when the model flagged the language rather than the conduct,
    // so a genuinely sexual or spammy line that happens to swear still comes through.
    return LANGUAGE_RULE.test(`${violation.rule} ${violation.reason}`);
}

function isViolation(value: unknown, batchSize: number): value is Violation {
    if (typeof value !== "object" || value === null) return false;
    const { index, rule, severity, reason, quote } = value as Record<string, unknown>;

    return Number.isInteger(index) && (index as number) >= 0 && (index as number) < batchSize
        && typeof rule === "string"
        && Number.isInteger(severity)
        && typeof reason === "string"
        && typeof quote === "string";
}

/**
 * Reads one batch of chat against the rules using a model on this machine. Nothing is
 * acted on here and nothing is written to disk; the caller decides what to do with the
 * answer. No part of the chat leaves the machine on this path.
 */
export async function review(_: IpcMainInvokeEvent, request: ReviewRequest): Promise<ReviewResult> {
    const model = request.model?.trim();
    if (!model || !MODEL_TAG.test(model)) return { ok: false, error: `"${request.model}" is not a valid model name.` };

    const rules = clamp(request.rules, MAX_RULES_CHARS, true);
    if (!rules) return { ok: false, error: "No rules are set, so there is nothing to check against." };

    const batch = (request.messages ?? []).slice(0, MAX_MESSAGES);
    if (!batch.length) return { ok: true, violations: [], usage: { input: 0, output: 0 } };

    let endpoint: URL;
    try {
        endpoint = new URL("/api/chat", request.baseUrl?.trim() || "http://127.0.0.1:11434");
    } catch {
        return { ok: false, error: `"${request.baseUrl}" is not a valid Ollama address.` };
    }

    const transcript = batch.map(describe).join("\n");

    try {
        const response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model,
                stream: false,
                // Without this the reasoning models emit a think block and the reply arrives
                // as prose wrapped around the JSON, which the schema cannot save us from.
                think: false,
                // Ollama constrains the reply to this schema, so even a small model returns
                // parseable JSON. It cannot make the judgement better, only the shape reliable.
                format: VIOLATION_SCHEMA,
                options: {
                    // Pinned deliberately: left unset, Ollama falls back to a small default
                    // context and silently drops the front of a full batch.
                    num_ctx: request.contextTokens || 8192,
                    temperature: 0
                },
                messages: [
                    { role: "system", content: `${SYSTEM_PROMPT}\n\n${rulesBlock(rules)}` },
                    { role: "user", content: `Transcript from one channel, oldest first:\n\n${transcript}` }
                ]
            }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });

        if (response.status === 404)
            return { ok: false, error: `Ollama has no model called "${model}". Run: ollama pull ${model}` };

        if (!response.ok)
            return { ok: false, error: `Ollama returned ${response.status}.` };

        const body = await response.json().catch(() => null) as {
            message?: { content?: string; };
            prompt_eval_count?: number;
            eval_count?: number;
        } | null;

        const text = body?.message?.content?.trim();
        if (!text) return { ok: false, error: "Ollama replied with nothing to read." };

        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            return { ok: false, error: "The model's reply was not readable as JSON." };
        }

        const allowedTerms = (request.allowedTerms ?? []).map(normaliseForMatching).filter(Boolean);
        const bannedTerms = (request.bannedTerms ?? []).map(normaliseForMatching).filter(Boolean);

        const raw = (parsed as { violations?: unknown; })?.violations;
        const violations = Array.isArray(raw)
            ? (raw.filter(item => isViolation(item, batch.length)) as Violation[])
                .map(violation => anchorToQuotedMessage(violation, batch))
                .filter((violation): violation is Violation => violation !== null)
                .filter(violation => !isPermittedWordOnly(violation, allowedTerms, bannedTerms))
            : [];

        return {
            ok: true,
            violations,
            usage: {
                input: body?.prompt_eval_count ?? 0,
                output: body?.eval_count ?? 0
            }
        };
    } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError")
            return { ok: false, error: "The model took too long, so this batch was skipped." };

        // Ollama not running is by far the most common failure, and the raw cause reads
        // as an opaque connect error, so it is worth naming.
        const cause = (error as { cause?: { code?: string; }; })?.cause?.code;
        if (cause === "ECONNREFUSED")
            return { ok: false, error: `Nothing is listening at ${endpoint.origin}. Is Ollama running?` };

        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

/**
 * Pushes flags to the xocat.host panel. This runs in the main process rather than the
 * renderer so it is not subject to Discord's content security policy, and so the panel
 * token stays out of the page. Failing to publish never blocks the local panel.
 */
export async function publish(_: IpcMainInvokeEvent, request: PublishRequest): Promise<PublishResult> {
    const token = request.token?.trim();
    if (!token) return { ok: false, error: "No panel token is set." };

    let endpoint: URL;
    try {
        endpoint = new URL("/api/modwatch/ingest", request.baseUrl?.trim());
    } catch {
        return { ok: false, error: `"${request.baseUrl}" is not a valid panel address.` };
    }

    // Flags travel with a bearer token, so plain http would put it on the wire in clear.
    if (endpoint.protocol !== "https:" && endpoint.hostname !== "localhost" && endpoint.hostname !== "127.0.0.1")
        return { ok: false, error: "The panel address has to be https." };

    const flags = (request.flags ?? []).slice(0, MAX_PUBLISHED_FLAGS);
    if (!flags.length) return { ok: true, stored: 0 };

    try {
        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({ flags }),
            signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS)
        });

        if (response.status === 401) return { ok: false, error: "The panel rejected the token." };
        if (!response.ok) return { ok: false, error: `The panel returned ${response.status}.` };

        const body = await response.json().catch(() => null) as { stored?: number; } | null;
        return { ok: true, stored: body?.stored ?? flags.length };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
