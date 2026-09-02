/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcMainInvokeEvent } from "electron";

import { BAO_EMOJI, MEMORY_HEADER, SYSTEM_PROMPT, VISION_PROMPT } from "./prompt";

const OLLAMA_CHAT_URL = "http://127.0.0.1:11434/api/chat";
const MAX_RESPONSE_BYTES = 256_000;
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * Longer than a plain reply, because describing a picture usually means swapping the vision
 * model into the GPU first, and on a modest card that swap is most of the wait.
 */
const VISION_TIMEOUT_MS = 240_000;
const MAX_HISTORY_MESSAGES = 50;
const MAX_MESSAGE_LENGTH = 600;
const MAX_HISTORY_CHARS = 2000;
const MAX_MEMORY_CHARS = 2000;
const MAX_REPLY_TOKENS = 150;
const MAX_DESCRIPTION_TOKENS = 200;
const MAX_DESCRIPTION_CHARS = 700;
const MODEL_TAG = /^[\w./:-]{1,200}$/;

const CASE_SENSITIVE_TOKEN = /https?:\/\/\S+|<[^\s>]+>/g;
const PLACEHOLDER = /\0(\d+)\0/g;
const WORD = /\p{L}+/gu;
const BAO_ATTEMPT = /<a?:bao:\d*>|:bao:/gi;
const EXTRA_SPACE = /\s{2,}/g;

/** How often a reply that reached for the emoji gets to keep it. */
const BAO_KEEP_CHANCE = 0.6;

const ATTACHMENT_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const MAX_IMAGES = 2;
const MAX_IMAGE_BYTES = 4_000_000;
const ATTACHMENT_TIMEOUT_MS = 20_000;

/** Extensions worth opening. Anything else is only named, never downloaded. */
const READABLE_EXTENSIONS = new Set([
    "txt", "md", "log", "json", "jsonl", "csv", "tsv", "yml", "yaml", "toml", "ini", "cfg", "env",
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "java", "kt", "rb", "php", "lua",
    "c", "h", "cpp", "hpp", "cs", "swift", "sql", "sh", "bat", "ps1", "css", "scss", "html", "xml", "svg", "diff", "patch"
]);
const MAX_FILES = 2;
const MAX_FILE_BYTES = 200_000;
const MAX_FILE_CHARS = 1200;
const MAX_FILENAME_LENGTH = 100;
const UNSAFE_FILENAME = /[\r\n\0]/g;

interface HistoryFile {
    name: string;
    url: string;
}

interface HistoryMessage {
    role: "user" | "assistant";
    content: string;
    images: string[];
    files: HistoryFile[];
}

type SuggestionResult =
    | { ok: true; content: string; }
    | { ok: false; error: string; offline?: boolean; };

/**
 * A word in ALL CAPS ("BRO", "LMFAOOO") is deliberate shouting and survives, while
 * anything merely capitalised the way ordinary writing would be ("Hi", "Cloudflare",
 * a lone "I") gets lowered. The model mostly gets this right on its own; this makes
 * it certain.
 *
 * Links and Discord mention/emoji tokens are held out first because they are case
 * sensitive and lowercasing them breaks them. The placeholder is NUL-delimited so it
 * cannot collide with a number the model actually wrote.
 */
function normaliseCaps(text: string): string {
    const held: string[] = [];
    const masked = text.replace(CASE_SENSITIVE_TOKEN, match => {
        held.push(match);
        return `\0${held.length - 1}\0`;
    });

    const lowered = masked.replace(WORD, word => {
        const shouted = word.length >= 2 && word === word.toUpperCase() && word !== word.toLowerCase();
        return shouted ? word : word.toLowerCase();
    });

    return lowered.replace(PLACEHOLDER, (_, index: string) => held[Number(index)]);
}

/**
 * Small models drop or mistype the digits in a custom emoji id, which renders as
 * literal text in the message box instead of the emoji. Any attempt at :bao: is
 * rewritten to the real token.
 */
function repairEmoji(text: string): string {
    return text.replace(BAO_ATTEMPT, BAO_EMOJI);
}

/**
 * The model treats the emoji as all or nothing, so it lands in every reply once the
 * prompt asks for it. This collapses repeats to the first one and then drops it
 * entirely some of the time, so it reads as a habit rather than a signature.
 */
function tuneEmojiFrequency(text: string): string {
    const first = text.indexOf(BAO_EMOJI);
    if (first === -1) return text;

    const cleaned = Math.random() < BAO_KEEP_CHANCE
        ? text.slice(0, first + BAO_EMOJI.length) + text.slice(first + BAO_EMOJI.length).split(BAO_EMOJI).join(" ")
        : text.split(BAO_EMOJI).join(" ");

    return cleaned.replace(EXTRA_SPACE, " ").trim();
}

function field(value: unknown, key: string): unknown {
    if (typeof value !== "object" || value === null) return undefined;
    return (value as Record<string, unknown>)[key];
}

function parseFiles(value: unknown): HistoryFile[] | null {
    if (value === undefined) return [];
    if (!Array.isArray(value)) return null;

    const files: HistoryFile[] = [];
    for (const entry of value.slice(0, MAX_FILES)) {
        const name = field(entry, "name");
        const url = field(entry, "url");

        if (typeof name !== "string" || typeof url !== "string") return null;

        files.push({ name: name.replace(UNSAFE_FILENAME, " ").slice(0, MAX_FILENAME_LENGTH), url });
    }

    return files;
}

function parseHistory(messages: unknown): HistoryMessage[] | null {
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_HISTORY_MESSAGES) return null;

    const history: HistoryMessage[] = [];
    for (const entry of messages) {
        const role = field(entry, "role");
        const content = field(entry, "content");

        if (role !== "user" && role !== "assistant") return null;
        if (typeof content !== "string") return null;

        const images = field(entry, "images");
        if (!Array.isArray(images) || images.some(url => typeof url !== "string")) return null;

        const files = parseFiles(field(entry, "files"));
        if (files === null) return null;

        // A message can be nothing but an attachment, so emptiness is only a problem
        // when there is nothing at all to go on.
        if (content.length === 0 && images.length === 0 && files.length === 0) return null;

        history.push({
            role,
            content: content.slice(0, MAX_MESSAGE_LENGTH),
            images: images.slice(0, MAX_IMAGES),
            files
        });
    }

    let used = 0;
    const budgeted: HistoryMessage[] = [];
    for (let i = history.length - 1; i >= 0; i--) {
        const entry = history[i];

        used += entry.content.length;
        if (used > MAX_HISTORY_CHARS && budgeted.length > 0) break;

        budgeted.unshift(entry);
    }

    return budgeted;
}

/**
 * The remembered lines arrive as one block of text the renderer already formatted. Only
 * the newest part is kept, since that is the part closest to what is being replied to.
 */
function parseMemory(value: unknown): string {
    if (typeof value !== "string") return "";

    const text = value.trim();
    return text.length > MAX_MEMORY_CHARS ? text.slice(-MAX_MEMORY_CHARS) : text;
}

/**
 * Downloads one attachment. The renderer supplies these URLs, so the host is checked
 * against a Discord CDN allowlist and the read is capped rather than trusted.
 */
async function fetchAttachment(url: string, maxBytes: number): Promise<Buffer | null> {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }

    if (parsed.protocol !== "https:" || !ATTACHMENT_HOSTS.has(parsed.hostname)) return null;

    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(ATTACHMENT_TIMEOUT_MS) });
        if (!res.ok || res.body === null) return null;

        const declared = Number(res.headers.get("content-length") ?? "0");
        if (declared > maxBytes) return null;

        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            size += value.length;
            if (size > maxBytes) {
                await reader.cancel();
                return null;
            }

            chunks.push(value);
        }

        return Buffer.concat(chunks);
    } catch {
        return null;
    }
}

/** Attaches at most MAX_IMAGES pictures, newest first, so one album cannot flood the model. */
async function attachImages(history: HistoryMessage[]): Promise<void> {
    let budget = MAX_IMAGES;

    // Every entry is reassigned, including ones past the budget, so a URL can never
    // survive into the request body where it would be sent as if it were image data.
    for (let i = history.length - 1; i >= 0; i--) {
        const entry = history[i];
        const encoded: string[] = [];

        for (const url of entry.images) {
            if (budget === 0) break;

            const image = await fetchAttachment(url, MAX_IMAGE_BYTES);
            if (image !== null) {
                encoded.push(image.toString("base64"));
                budget--;
            }
        }

        entry.images = encoded;
    }
}

/**
 * Asks a vision model what is in one picture. A failure means the picture goes unmentioned,
 * which is still better than no reply at all.
 */
async function describeImage(model: string, image: string): Promise<string | null> {
    try {
        const res = await fetch(OLLAMA_CHAT_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model,
                messages: [{ role: "user", content: VISION_PROMPT, images: [image] }],
                stream: false,
                think: false,
                options: { num_predict: MAX_DESCRIPTION_TOKENS }
            }),
            signal: AbortSignal.timeout(VISION_TIMEOUT_MS)
        });

        if (!res.ok || res.body === null) return null;

        const raw = await readCapped(res.body);
        if (raw === null) return null;

        const content = field(field(JSON.parse(raw), "message"), "content");
        if (typeof content !== "string" || content.trim().length === 0) return null;

        return content.trim().replace(EXTRA_SPACE, " ").slice(0, MAX_DESCRIPTION_CHARS);
    } catch {
        return null;
    }
}

/**
 * Turns the pictures on a message into words inside its text and drops the image data, so a
 * model that cannot see gets to answer them anyway. Without a vision model set the images
 * are left alone for a model that can see them itself.
 */
async function describeImages(history: HistoryMessage[], model: string): Promise<void> {
    for (const entry of history) {
        if (entry.images.length === 0) continue;

        const notes: string[] = [];
        for (const image of entry.images) {
            const description = await describeImage(model, image);
            notes.push(description === null ? "[a picture, could not make it out]" : `[picture: ${description}]`);
        }

        entry.images = [];
        entry.content = [entry.content, ...notes].filter(part => part.length > 0).join("\n");
    }
}

/**
 * Opens text attachments and folds them into the message they arrived with, so a draft
 * can answer what is actually in the file. Anything not on the readable list is named
 * and nothing else, which is still worth knowing: "u sent a zip" is a reply.
 */
async function attachFiles(history: HistoryMessage[]): Promise<void> {
    let budget = MAX_FILES;

    for (let i = history.length - 1; i >= 0; i--) {
        const entry = history[i];
        const notes: string[] = [];

        for (const file of entry.files) {
            const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
            const contents = budget > 0 && READABLE_EXTENSIONS.has(extension)
                ? await fetchAttachment(file.url, MAX_FILE_BYTES)
                : null;

            if (contents === null) {
                notes.push(`[attached ${file.name}]`);
                continue;
            }

            budget--;
            notes.push(`[attached ${file.name}]\n${contents.toString("utf8").slice(0, MAX_FILE_CHARS)}`);
        }

        // Cleared whether or not anything was read, so a URL can never survive into the
        // request body where it would be sent as if it were file contents.
        entry.files = [];
        if (notes.length > 0) entry.content = [entry.content, ...notes].filter(part => part.length > 0).join("\n");
    }
}

async function readCapped(body: ReadableStream<Uint8Array>): Promise<string | null> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let text = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        size += value.length;
        if (size > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            return null;
        }

        text += decoder.decode(value, { stream: true });
    }

    return text + decoder.decode();
}

function readResponse(raw: string, status: number): SuggestionResult {
    let data: unknown;
    try {
        data = JSON.parse(raw);
    } catch {
        return { ok: false, error: `Ollama sent back something unreadable (HTTP ${status}).` };
    }

    const detail = field(data, "error");
    if (typeof detail === "string" && detail.length > 0)
        return { ok: false, error: `Ollama refused the request: ${detail}` };

    const content = field(field(data, "message"), "content");
    if (typeof content !== "string" || content.trim().length === 0)
        return { ok: false, error: "Ollama answered without any text to use." };

    return { ok: true, content: tuneEmojiFrequency(repairEmoji(normaliseCaps(content.trim()))) };
}

function describeFailure(e: unknown): SuggestionResult {
    if (e instanceof Error && e.name === "TimeoutError")
        return { ok: false, error: "Ollama took too long to answer. It may still be loading the model." };

    const code = field(e instanceof Error ? e.cause : undefined, "code");
    if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EHOSTUNREACH")
        return { ok: false, offline: true, error: "Nothing is answering on localhost:11434. Start Ollama and try again." };

    return { ok: false, offline: true, error: "Could not reach Ollama on this machine." };
}

export async function requestSuggestion(_: IpcMainInvokeEvent, model: unknown, messages: unknown, memory: unknown, visionModel: unknown): Promise<SuggestionResult> {
    if (typeof model !== "string" || !MODEL_TAG.test(model))
        return { ok: false, error: "That model name is not a usable Ollama tag." };

    const vision = typeof visionModel === "string" ? visionModel.trim() : "";
    if (vision.length > 0 && !MODEL_TAG.test(vision))
        return { ok: false, error: "That vision model name is not a usable Ollama tag." };

    const history = parseHistory(messages);
    if (history === null)
        return { ok: false, error: "The conversation context was malformed, so nothing was sent." };

    const remembered = parseMemory(memory);
    const system = remembered.length > 0
        ? `${SYSTEM_PROMPT}\n\n${MEMORY_HEADER}\n${remembered}`
        : SYSTEM_PROMPT;

    await attachImages(history);
    if (vision.length > 0) await describeImages(history, vision);
    await attachFiles(history);

    try {
        const res = await fetch(OLLAMA_CHAT_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model,
                messages: [
                    { role: "system", content: system },
                    ...history.map(({ role, content, images }) => images.length > 0
                        ? { role, content, images }
                        : { role, content })
                ],
                stream: false,
                think: false,
                options: { num_predict: MAX_REPLY_TOKENS }
            }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });

        if (res.body === null)
            return { ok: false, error: `Ollama sent back an empty response (HTTP ${res.status}).` };

        const raw = await readCapped(res.body);
        if (raw === null)
            return { ok: false, error: "Ollama sent back far more data than a reply should need." };

        return readResponse(raw, res.status);
    } catch (e) {
        return describeFailure(e);
    }
}
