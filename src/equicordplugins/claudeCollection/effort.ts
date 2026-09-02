/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addMessagePreSendListener, MessageSendListener, removeMessagePreSendListener } from "@api/MessageEvents";

import { logoSvg } from "./logo";
import { settings } from "./settings";

const INDICATOR_ID = "claude-thinking";
const STYLE_ID = "claude-effort-style";

/** How often the spinner word changes, and how often the elapsed counter ticks. */
const WORD_MS = 1100;
const TICK_MS = 100;

export interface EffortLevel {
    name: string;
    /** Milliseconds the message is held before it actually posts. */
    delay: number;
    /** The top tier, which gets the violet treatment. */
    ultra?: boolean;
}

/**
 * Six stops on the effort slider. The delays are pure theatre — the message is
 * unchanged, it just leaves later.
 */
export const EFFORT_LEVELS: EffortLevel[] = [
    { name: "Low", delay: 800 },
    { name: "Medium", delay: 2000 },
    { name: "High", delay: 3800 },
    { name: "Extra", delay: 6000 },
    { name: "Max", delay: 9000 },
    { name: "Ultracode", delay: 14000, ultra: true },
];

export function isUltra(): boolean {
    return Boolean(EFFORT_LEVELS[currentLevel()].ultra);
}

/**
 * Spinner words in the spirit of the Claude Code CLI's. Approximated rather than
 * copied from an authoritative list, so treat the exact set as decoration.
 */
const WORDS = [
    "Thinking", "Pondering", "Musing", "Noodling", "Percolating", "Ruminating",
    "Cogitating", "Simmering", "Brewing", "Deliberating", "Marinating", "Mulling",
    "Puzzling", "Contemplating", "Wrangling", "Finagling", "Schlepping", "Vibing",
    "Scheming", "Spelunking", "Conjuring", "Synthesising", "Distilling",
    "Untangling", "Meandering", "Reticulating", "Channelling", "Herding",
];

let style: HTMLStyleElement | null = null;
let listener: MessageSendListener | null = null;

/** How many sends are currently being held. The indicator is shared between them. */
let queued = 0;
/**
 * Tail of the send queue. Each held message chains onto the previous one, so they
 * leave in the order you sent them even if the effort level changes in between.
 */
let tail: Promise<void> = Promise.resolve();
let wordTimer: number | null = null;
let tickTimer: number | null = null;
let startedAt = 0;

export function currentLevel(): number {
    const raw = Math.round(settings.store.effortLevel);
    return Math.min(EFFORT_LEVELS.length - 1, Math.max(0, raw));
}

export function setLevel(index: number) {
    settings.store.effortLevel = Math.min(EFFORT_LEVELS.length - 1, Math.max(0, index));
}

export function currentName(): string {
    return EFFORT_LEVELS[currentLevel()].name;
}

/* ------------------------------------------------------------------ *
 * Indicator
 * ------------------------------------------------------------------ */

function findComposer(): HTMLElement | null {
    return document.querySelector<HTMLElement>('[class*="channelTextArea_"]');
}

function randomWord(exclude?: string): string {
    const pool = exclude ? WORDS.filter(w => w !== exclude) : WORDS;
    return pool[Math.floor(Math.random() * pool.length)];
}

/** Writes the "· N queued" suffix, or clears it when only one is held. */
function paintQueue() {
    const el = document.querySelector<HTMLElement>(`#${INDICATOR_ID} .cl-thinking-queue`);
    if (el) el.textContent = queued > 1 ? `· ${queued - 1} queued` : "";
}

function show() {
    // Already up: a second send just deepens the queue, it doesn't restack the pill.
    if (document.getElementById(INDICATOR_ID)) {
        paintQueue();
        return;
    }

    const composer = findComposer();
    if (!composer) return;

    startedAt = Date.now();

    const el = document.createElement("div");
    el.id = INDICATOR_ID;
    // Decorative status text; announced politely rather than interrupting.
    el.setAttribute("role", "status");
    if (isUltra()) el.classList.add("cl-ultra");

    el.appendChild(logoSvg("cl-thinking-mark"));

    const word = document.createElement("span");
    word.className = "cl-thinking-word";
    word.textContent = `${randomWord()}…`;
    el.appendChild(word);

    const elapsed = document.createElement("span");
    elapsed.className = "cl-thinking-elapsed";
    el.appendChild(elapsed);

    const queue = document.createElement("span");
    queue.className = "cl-thinking-queue";
    el.appendChild(queue);

    composer.appendChild(el);
    paintQueue();

    wordTimer = window.setInterval(() => {
        word.textContent = `${randomWord(word.textContent?.replace("…", ""))}…`;
    }, WORD_MS);

    tickTimer = window.setInterval(() => {
        const secs = (Date.now() - startedAt) / 1000;
        elapsed.textContent = `(${secs.toFixed(1)}s)`;
    }, TICK_MS);
}

function hide(force = false) {
    if (force) queued = 0;
    // Something is still queued behind this one; keep the pill up for it.
    else if (queued > 0) {
        paintQueue();
        return;
    }

    if (wordTimer !== null) {
        window.clearInterval(wordTimer);
        wordTimer = null;
    }
    if (tickTimer !== null) {
        window.clearInterval(tickTimer);
        tickTimer = null;
    }

    document.getElementById(INDICATOR_ID)?.remove();
}

/* ------------------------------------------------------------------ *
 * Send delay
 * ------------------------------------------------------------------ */

const onPreSend: MessageSendListener = async () => {
    const { delay } = EFFORT_LEVELS[currentLevel()];
    if (!delay) return;

    queued++;
    show();

    // Chained onto the tail rather than each message sleeping independently: that
    // way they post in the order you sent them even if you change the effort
    // level, or send a Low one behind an Ultracode one, while the first is held.
    // _handlePreSend awaits its listeners, so waiting here genuinely holds the
    // message rather than racing the send.
    const mine = tail.then(() => new Promise<void>(resolve => setTimeout(resolve, delay)));
    // The tail must never reject, or one failure would wedge the whole queue.
    tail = mine.catch(() => undefined);

    try {
        await mine;
    } finally {
        // finally, so a throw anywhere downstream can't leave the pill stuck up.
        queued--;
        hide();
    }
};

export function restyle() {
    style?.remove();

    style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
#${INDICATOR_ID} {
    position: absolute;
    left: 6px;
    bottom: calc(100% + 6px);
    z-index: 200;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 4px 10px 4px 8px;
    border: 1px solid var(--cl-border, var(--border-subtle, rgba(255,255,255,.08)));
    border-radius: var(--radius-round, 999px);
    background: var(--cl-bg-float, var(--background-floating, #2f2f2c));
    box-shadow: var(--cl-shadow-low, 0 1px 2px rgba(0,0,0,.3));
    font-family: var(--cl-sans, inherit);
    font-size: 12px;
    line-height: 1;
    user-select: none;
    pointer-events: none;
}

#${INDICATOR_ID} .cl-thinking-mark {
    width: 14px;
    height: 14px;
    flex: 0 0 auto;
    color: var(--cl-accent, #d97757);
    animation: cl-thinking-spin 2.4s linear infinite;
}

#${INDICATOR_ID} .cl-thinking-word {
    color: var(--cl-text-2, var(--text-default, #e5e4df));
    font-weight: 500;
}

#${INDICATOR_ID} .cl-thinking-elapsed,
#${INDICATOR_ID} .cl-thinking-queue {
    color: var(--cl-text-5, var(--text-muted, #85837c));
    font-variant-numeric: tabular-nums;
}

#${INDICATOR_ID} .cl-thinking-queue:empty {
    display: none;
}

/* Ultracode gets the violet mark to match the slider. */
#${INDICATOR_ID}.cl-ultra .cl-thinking-mark {
    color: #a78bfa;
}

@keyframes cl-thinking-spin {
    to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
    #${INDICATOR_ID} .cl-thinking-mark { animation: none; }
}
`;
    document.head.appendChild(style);
}

export function start() {
    restyle();

    listener = onPreSend;
    addMessagePreSendListener(listener);
}

export function stop() {
    if (listener) {
        removeMessagePreSendListener(listener);
        listener = null;
    }

    hide(true);
    style?.remove();
    style = null;
}
