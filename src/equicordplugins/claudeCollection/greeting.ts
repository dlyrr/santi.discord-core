/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { UserStore } from "@webpack/common";

import { logoSvg } from "./logo";
import { settings } from "./settings";

const OVERLAY_ID = "claude-greeting-overlay";
const STYLE_ID = "claude-greeting-style";

// The overlay goes up before Discord has finished connecting, so the current
// user usually isn't in the store yet. Poll for it rather than waiting on
// CONNECTION_OPEN, which fires later than we want the mark on screen.
const NAME_POLL_MS = 100;
const NAME_POLL_LIMIT = 100; // 10s, then give up and greet without a name

const FADE_MS = 420;

/** Nothing may keep the splash up longer than this, whatever else goes wrong. */
const HARD_CAP_MS = 12_000;

/**
 * The setting is in seconds, but earlier builds stored milliseconds in the same
 * key — a saved 2400 became a 40-minute splash you couldn't click out of. Values
 * too large to be seconds are read as the millisecond leftovers they are, and the
 * result is clamped so no stored value can strand you here again.
 */
function greetingMs(): number {
    const raw = Number(settings.store.greetingDuration);
    if (!Number.isFinite(raw) || raw <= 0) return 2400;

    const ms = raw > 60 ? raw : raw * 1000;
    return Math.min(Math.max(ms, 400), 8000);
}

let overlay: HTMLDivElement | null = null;
let style: HTMLStyleElement | null = null;
const timers: number[] = [];
let poll: number | null = null;

/* ------------------------------------------------------------------ *
 * Greeting table
 * ------------------------------------------------------------------ */

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

type Day = typeof DAYS[number];

interface Greeting {
    /** `{name}` is substituted with the display name. Lines without it are used verbatim. */
    text: string;
    /** Empty means any day. */
    days?: Day[];
    /** [startHour, endHour), wrapping when end <= start (e.g. [21, 6] is late night). */
    hours: [number, number];
    /** Plainest line for its band — the only ones used when Variety is off. */
    canonical?: boolean;
}

const MORNING: [number, number] = [6, 12];
const AFTERNOON: [number, number] = [12, 17];
const EVENING: [number, number] = [17, 21];
const LATE: [number, number] = [21, 6];
const ANY: [number, number] = [0, 24];

// Lines and their day/hour bands follow Posandu's collection of Claude's own
// greetings: https://gist.github.com/Posandu/e97d3cd20a671749ce7162a2a4f51fee
const GREETINGS: Greeting[] = [
    // --- morning ---
    { text: "Good morning, {name}", hours: MORNING, canonical: true },
    { text: "Welcome, {name}", hours: MORNING },
    { text: "Hey there, {name}", hours: MORNING },
    { text: "Coffee and Claude time?", hours: MORNING },
    { text: "Happy Monday, {name}", hours: MORNING, days: ["Monday"] },
    { text: "Happy Tuesday, {name}", hours: MORNING, days: ["Tuesday"] },
    { text: "Happy Wednesday, {name}", hours: MORNING, days: ["Wednesday"] },
    { text: "Happy Thursday, {name}", hours: MORNING, days: ["Thursday"] },
    { text: "Happy Friday, {name}", hours: MORNING, days: ["Friday"] },
    { text: "That Friday feeling, {name}", hours: MORNING, days: ["Friday"] },
    { text: "Happy Saturday, {name}", hours: MORNING, days: ["Saturday"] },
    { text: "Happy Sunday, {name}", hours: MORNING, days: ["Sunday"] },
    { text: "Welcome to the weekend, {name}", hours: MORNING, days: ["Saturday", "Sunday"] },
    { text: "What's on your mind, {name}?", hours: MORNING, days: ["Saturday", "Sunday"] },
    { text: "Sunday session, {name}?", hours: MORNING, days: ["Sunday"] },

    // --- afternoon ---
    { text: "Good afternoon, {name}", hours: AFTERNOON, canonical: true },
    { text: "Hi {name}, how are you?", hours: AFTERNOON },
    { text: "What's new, {name}?", hours: AFTERNOON },
    { text: "Back at it, {name}", hours: AFTERNOON },

    // --- evening ---
    { text: "Good evening, {name}", hours: EVENING, canonical: true },
    { text: "Evening, {name}", hours: EVENING },
    { text: "{name} returns!", hours: EVENING },
    { text: "How was your day, {name}?", hours: EVENING },

    // --- late night ---
    { text: "Hello, night owl", hours: LATE, canonical: true },
    { text: "How's it going, {name}?", hours: LATE },
    { text: "What's on your mind tonight?", hours: LATE },
    { text: "It's a late night jam session.", hours: LATE },
    { text: "Working late, {name}?", hours: LATE },
    { text: "Burning the midnight oil, {name}", hours: LATE },

    // --- any hour ---
    { text: "Welcome back, {name}", hours: ANY },
    { text: "Good to see you, {name}", hours: ANY },
    { text: "Ready when you are, {name}", hours: ANY },
    { text: "Let's get to it, {name}", hours: ANY },
    { text: "Where should we begin, {name}?", hours: ANY },
];

function inBand(hour: number, [start, end]: [number, number]): boolean {
    // Wrapping band, e.g. [21, 6] covers 21:00–05:59.
    return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** Plain time-of-day label, used when no name is available and nothing name-free fits. */
function bandLabel(hour: number): string {
    if (inBand(hour, MORNING)) return "Good morning";
    if (inBand(hour, AFTERNOON)) return "Good afternoon";
    if (inBand(hour, EVENING)) return "Good evening";
    return "Hello, night owl";
}

function pickGreeting(now: Date, variety: boolean, name: string | null): string {
    const hour = now.getHours();
    const today = DAYS[now.getDay()];

    let pool = GREETINGS.filter(g =>
        inBand(hour, g.hours)
        && (!g.days?.length || g.days.includes(today))
        && (variety || g.canonical));

    // Without a name, only lines that don't need one are usable.
    if (!name) pool = pool.filter(g => !g.text.includes("{name}"));

    if (!pool.length) return bandLabel(hour);

    const chosen = pool[Math.floor(Math.random() * pool.length)].text;
    return name ? chosen.replaceAll("{name}", name) : chosen;
}

function displayName(): string | null {
    const user = UserStore?.getCurrentUser?.();
    if (!user) return null;
    // globalName is the display name; falls back to the handle for accounts
    // that never set one.
    return (user as any).globalName || user.username || null;
}

/* ------------------------------------------------------------------ *
 * Overlay
 * ------------------------------------------------------------------ */

function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;

    style = document.createElement("style");
    style.id = STYLE_ID;
    // Colours come from the Claude theme when it's active, with its values
    // inlined as fallbacks so the splash still looks right on stock Discord.
    style.textContent = `
#${OVERLAY_ID} {
    position: fixed;
    inset: 0;
    z-index: 100000;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--cl-bg-canvas, var(--background-primary, #262624));
    opacity: 1;
    transition: opacity ${FADE_MS}ms ease;
    cursor: pointer;
    /* Deliberately NOT -webkit-app-region: drag. Electron treats a drag region as
       window chrome and swallows mouse events, so click-to-skip silently did
       nothing — which is how a bad duration became unescapable. */
}

#${OVERLAY_ID}.cl-greet-out {
    opacity: 0;
    pointer-events: none;
}

#${OVERLAY_ID} .cl-greet-inner {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 28px;
    user-select: none;
}

#${OVERLAY_ID} .cl-greet-logo {
    width: 72px;
    height: 72px;
    color: var(--cl-accent, #d97757);
    animation: cl-greet-bloom 700ms cubic-bezier(0.22, 1, 0.36, 1) both;
}

#${OVERLAY_ID} .cl-greet-text {
    font-family: var(--cl-display, "Anthropic Sans Display", "Anthropic Sans Text", ui-sans-serif, system-ui, sans-serif);
    font-weight: 500;
    font-size: 30px;
    letter-spacing: -0.018em;
    color: var(--cl-text-1, var(--header-primary, #faf9f5));
    opacity: 0;
    transform: translateY(6px);
    transition: opacity 460ms ease, transform 460ms cubic-bezier(0.22, 1, 0.36, 1);
    text-align: center;
    padding-inline: 32px;
    text-wrap: balance;
}

#${OVERLAY_ID} .cl-greet-text.cl-greet-in {
    opacity: 1;
    transform: none;
}

@keyframes cl-greet-bloom {
    from { opacity: 0; transform: scale(0.8) rotate(-32deg); }
    to   { opacity: 1; transform: none; }
}

@media (prefers-reduced-motion: reduce) {
    #${OVERLAY_ID} .cl-greet-logo { animation: none; }
    #${OVERLAY_ID} .cl-greet-text {
        transition: opacity 200ms ease;
        transform: none;
    }
}
`;
    document.head.appendChild(style);
}

function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape" || e.key === "Enter" || e.key === " ") dismiss();
}

function dismiss() {
    document.removeEventListener("keydown", onKeyDown, true);

    if (!overlay) return;

    const node = overlay;
    overlay = null;
    node.classList.add("cl-greet-out");
    timers.push(window.setTimeout(() => node.remove(), FADE_MS + 60));
}

export function start() {
    if (document.getElementById(OVERLAY_ID)) return;

    // Rewrite a legacy millisecond value as seconds, so the settings slider isn't
    // pinned off the end of its range showing something like 2400.
    const stored = Number(settings.store.greetingDuration);
    if (Number.isFinite(stored) && stored > 60) {
        settings.store.greetingDuration = Math.min(8, Math.max(1.2, stored / 1000));
    }

    injectStyle();

    overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;

    const inner = document.createElement("div");
    inner.className = "cl-greet-inner";

    if (settings.store.greetingShowLogo) inner.appendChild(logoSvg("cl-greet-logo"));

    const text = document.createElement("div");
    text.className = "cl-greet-text";
    inner.appendChild(text);

    overlay.appendChild(inner);
    // Click anywhere, or press Escape/Enter/Space, to skip.
    overlay.addEventListener("click", dismiss);
    document.addEventListener("keydown", onKeyDown, true);
    document.body.appendChild(overlay);

    // Last line of defence: comes down on its own even if the name never resolves
    // or the reveal below never runs.
    timers.push(window.setTimeout(dismiss, HARD_CAP_MS));

    const reveal = (name: string | null) => {
        const override = settings.store.greetingName.trim();
        // Picked here rather than up front because which lines are eligible
        // depends on whether a name resolved at all.
        // textContent, not innerHTML — display names are arbitrary user input.
        text.textContent = pickGreeting(new Date(), settings.store.greetingVariety, override || name);
        // Next frame, so the transition actually runs.
        requestAnimationFrame(() => text.classList.add("cl-greet-in"));
        timers.push(window.setTimeout(dismiss, greetingMs()));
    };

    if (settings.store.greetingName.trim()) {
        reveal(null);
        return;
    }

    const immediate = displayName();
    if (immediate) {
        reveal(immediate);
        return;
    }

    // Mark is already up; wait for the store to populate, then write the line.
    let tries = 0;
    poll = window.setInterval(() => {
        const name = displayName();
        if (name || ++tries >= NAME_POLL_LIMIT) {
            if (poll !== null) window.clearInterval(poll);
            poll = null;
            reveal(name);
        }
    }, NAME_POLL_MS);
}

export function stop() {
    if (poll !== null) {
        window.clearInterval(poll);
        poll = null;
    }
    for (const t of timers) window.clearTimeout(t);
    timers.length = 0;

    document.getElementById(OVERLAY_ID)?.remove();
    overlay = null;
    style?.remove();
    style = null;
}
