/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { MessageObject } from "@api/MessageEvents";
import { definePluginSettings } from "@api/Settings";
import { Devs, EquicordDevs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { makeRange, OptionType } from "@utils/types";

const logger = new Logger("BetterTyping");

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const settings = definePluginSettings({
    quickDisable: {
        type: OptionType.BOOLEAN,
        description: "Quick disable. Turns off all message modifying without requiring a client reload.",
        default: false,
    },

    // ----- Links -----
    linkifyDomains: {
        type: OptionType.SELECT,
        description: "Turn bare domains you type (nohello.net) into links. Only real top-level domains count, checked against IANA's list.",
        options: [
            { label: "Off", value: "off" },
            { label: "Replace the text with the link — https://nohello.net", value: "replace", default: true },
            { label: "Keep the text, hide the link inside it — [nohello.net](https://nohello.net)", value: "masked" },
        ],
    },
    clearTrackingParams: {
        type: OptionType.BOOLEAN,
        description: "Remove tracking parameters from links you send (ClearURLs rules).",
        default: true,
    },
    fixEmbeds: {
        type: OptionType.BOOLEAN,
        description: "Rewrite links to their embed-fixing mirrors (open.spotify.com → open.fxspotify.com, music.apple.com → open.fxapplemusic.com, x.com → fixupx.com, ...). Links wrapped in <> are left alone.",
        default: true,
    },
    customEmbedFixes: {
        type: OptionType.STRING,
        description: "Extra or overriding embed fixes, comma separated, as host>replacement (e.g. x.com>fxtwitter.com). Map a host to itself to keep it untouched.",
        default: "",
    },

    // ----- Wording -----
    blockedWords: {
        type: OptionType.STRING,
        description: "Words that will not be capitalized (comma separated).",
        default: "",
    },
    fixApostrophes: {
        type: OptionType.BOOLEAN,
        description: "Ensure contractions contain apostrophes.",
        default: true,
    },
    expandContractions: {
        type: OptionType.BOOLEAN,
        description: "Expand contractions.",
        default: false,
    },
    fixCapitalization: {
        type: OptionType.BOOLEAN,
        description: "Capitalize sentences.",
        default: false,
    },
    fixPunctuation: {
        type: OptionType.BOOLEAN,
        description: "Punctate sentences.",
        default: false,
    },
    fixPunctuationFrequency: {
        type: OptionType.SLIDER,
        description: "Percent period frequency (this majorly annoys some people).",
        markers: makeRange(0, 100, 10),
        stickToMarkers: false,
        default: 100,
    },

    // ----- Typing style -----
    typingStyle: {
        type: OptionType.SELECT,
        description: "Typing style. Restyles the letters of everything you send, applied last. Links, mentions, emoji, emails and code are never touched.",
        options: [
            { label: "Off (send as typed)", value: "off", default: true },
            { label: "lowercase — \"hi wats going on\"", value: "lowercase" },
            { label: "UPPERCASE — \"HI WATS GOING ON\"", value: "uppercase" },
            { label: "Title Case — \"Hi Wats Going On\"", value: "titlecase" },
            { label: "Sentence case — \"Hi wats going on. Ok\"", value: "sentencecase" },
            { label: "aLtErNaTiNg — \"hI wAtS gOiNg On\"", value: "alternating" },
        ],
    },
});

// ---------------------------------------------------------------------------
// Embed fixes
// ---------------------------------------------------------------------------

// host -> replacement host. Lookup tries the exact host first, then the host
// without a leading "www.", so entries only need the bare domain unless a
// subdomain maps somewhere specific.
const DEFAULT_EMBED_FIXES: Record<string, string> = {
    "open.spotify.com": "open.fxspotify.com",
    "music.apple.com": "open.fxapplemusic.com",
    "twitter.com": "fxtwitter.com",
    "mobile.twitter.com": "fxtwitter.com",
    "x.com": "fixupx.com",
    "bsky.app": "fxbsky.app",
    "instagram.com": "instagramez.com",
    "tiktok.com": "vxtiktok.com",
    "vm.tiktok.com": "vm.vxtiktok.com",
    "vt.tiktok.com": "vt.vxtiktok.com",
    "reddit.com": "rxddit.com",
    "old.reddit.com": "old.rxddit.com",
    "pixiv.net": "phixiv.net",
    "tumblr.com": "tpmblr.com",
};

function getEmbedFixes(): Record<string, string> {
    const fixes = { ...DEFAULT_EMBED_FIXES };
    for (const pair of settings.store.customEmbedFixes.split(",")) {
        const [from, to] = pair.split(">").map(s => s.trim().toLowerCase());
        if (from && to) fixes[from] = to;
    }
    return fixes;
}

function lookupFix(fixes: Record<string, string>, host: string): string | undefined {
    const lower = host.toLowerCase();
    return fixes[lower] ?? fixes[lower.replace(/^www\./, "")];
}

function fixEmbedHost(url: string): string {
    const fixes = getEmbedFixes();
    return url.replace(/^(https?:\/\/)([^/?#:]+)/i, (whole, scheme: string, host: string) => {
        const replacement = lookupFix(fixes, host);
        if (!replacement || replacement === host.toLowerCase()) return whole;
        return scheme + replacement;
    });
}

// The ClearURLs rules are keyed on the original hosts, so a link that is
// already on a fixer host (open.fxspotify.com/...?si=...) would slip past
// them. This maps a fixer host back to the host its rules are written for.
function originalHostFor(host: string): string | undefined {
    const lower = host.toLowerCase();
    for (const [from, to] of Object.entries(getEmbedFixes())) {
        if (to === lower && from !== lower) return from;
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// ClearURLs (tracking parameter removal)
// ---------------------------------------------------------------------------

const CLEAR_URLS_JSON_URL = "https://raw.githubusercontent.com/ClearURLs/Rules/master/data.min.json";

interface Provider {
    urlPattern: string;
    completeProvider: boolean;
    rules?: string[];
    rawRules?: string[];
    referralMarketing?: string[];
    exceptions?: string[];
    redirections?: string[];
    forceRedirection?: boolean;
}

interface ClearUrlsData {
    providers: Record<string, Provider>;
}

interface RuleSet {
    name: string;
    urlPattern: RegExp;
    rules?: RegExp[];
    rawRules?: RegExp[];
    exceptions?: RegExp[];
}

let rules: RuleSet[] = [];

async function createRules() {
    const res = await fetch(CLEAR_URLS_JSON_URL).then(r => r.json()) as ClearUrlsData;

    rules = [];
    for (const [name, provider] of Object.entries(res.providers)) {
        rules.push({
            name,
            urlPattern: new RegExp(provider.urlPattern, "i"),
            rules: provider.rules?.map(rule => new RegExp(rule, "i")),
            rawRules: provider.rawRules?.map(rule => new RegExp(rule, "i")),
            exceptions: provider.exceptions?.map(ex => new RegExp(ex, "i")),
        });
    }
}

function clearTracking(match: string): string {
    let url: URL;
    try {
        url = new URL(match);
    } catch {
        // Don't modify anything if we can't parse the URL
        return match;
    }

    // Cheap way to check if there are any search params
    if (url.searchParams.entries().next().done) return match;

    // Run the rules as if the link were still on its original host, then put
    // the fixer host back afterwards.
    const fixerHost = url.hostname;
    const originalHost = originalHostFor(fixerHost);
    if (originalHost) url.hostname = originalHost;

    for (const { urlPattern, exceptions, rawRules, rules: paramRules } of rules) {
        if (!urlPattern.test(url.href) || exceptions?.some(ex => ex.test(url.href))) continue;

        const toDelete: string[] = [];
        if (paramRules) {
            url.searchParams.forEach((_, param) => {
                if (paramRules.some(rule => rule.test(param))) toDelete.push(param);
            });
        }
        toDelete.forEach(param => url.searchParams.delete(param));

        let cleanedUrl = url.href;
        rawRules?.forEach(rawRule => {
            cleanedUrl = cleanedUrl.replace(rawRule, "");
        });
        url = new URL(cleanedUrl);
    }

    if (originalHost) url.hostname = fixerHost;
    return url.toString();
}

// ---------------------------------------------------------------------------
// Linkify bare domains
// ---------------------------------------------------------------------------

const IANA_TLDS_URL = "https://data.iana.org/TLD/tlds-alpha-by-domain.txt";

// Used until IANA's list arrives, or if it never does.
const FALLBACK_TLDS = [
    "com", "net", "org", "io", "dev", "app", "gg", "me", "co", "us", "uk", "ca", "de", "fr", "es", "it",
    "nl", "se", "no", "fi", "dk", "pl", "ru", "jp", "kr", "cn", "in", "br", "mx", "au", "nz", "eu",
    "info", "biz", "xyz", "tv", "fm", "ai", "sh", "to", "cc", "ly", "st", "moe", "wiki", "page", "site",
    "online", "host", "cloud", "tech", "run", "live", "chat", "social", "art", "one", "top", "pro", "edu", "gov",
];

// TLDs that are far more often file extensions in chat than domains.
const AMBIGUOUS_TLDS = new Set(["zip", "mov"]);

let tlds = new Set(FALLBACK_TLDS);

async function loadTlds() {
    const text = await fetch(IANA_TLDS_URL).then(r => r.text());
    const list = text
        .split("\n")
        .map(line => line.trim().toLowerCase())
        .filter(line => line && !line.startsWith("#"));
    if (list.length > 0) tlds = new Set(list);
}

// A bare domain, optionally with a path, that is not already part of a link,
// an email or a mention. The lookbehind keeps "https://x.com", "bob@x.com"
// and "@x.com" out of it; the lookahead stops before closing punctuation.
const BARE_DOMAIN = /(?<![\w@/.:-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+)([a-z]{2,63}|xn--[a-z0-9-]+)(:\d{1,5})?(\/[^\s<]*[^\s<.,:;"'>)|\]])?(?=$|[\s.,;:!?)\]"'>])/gi;

type LinkifyMode = "off" | "replace" | "masked";

function linkifyDomains(text: string, mode: LinkifyMode): string {
    if (mode === "off") return text;
    return text.replace(BARE_DOMAIN, (whole, labels: string, tld: string, port = "", path = "") => {
        const lower = tld.toLowerCase();
        if (!tlds.has(lower) || AMBIGUOUS_TLDS.has(lower)) return whole;
        const link = `https://${labels}${tld}${port}${path}`;
        // Discord's masked-link markdown: the text stays, the link hides inside it.
        return mode === "masked" ? `[${whole}](${link})` : link;
    });
}

// ---------------------------------------------------------------------------
// Link pipeline
// ---------------------------------------------------------------------------

// Same URL shape ClearURLs matches, with an optional leading "<" captured so
// embed-suppressed links can be recognised (and their host left alone).
const URL_REGEX = /(<?)(https?:\/\/[^\s<]+[^<.,:;"'>)|\]\s])/g;

function processLinks(text: string): string {
    text = linkifyDomains(text, settings.store.linkifyDomains as LinkifyMode);
    if (!/https?:\/\//.test(text)) return text;

    const { clearTrackingParams, fixEmbeds } = settings.store;
    if (!clearTrackingParams && !fixEmbeds) return text;

    return text.replace(URL_REGEX, (_, bracket: string, url: string) => {
        let out = url;
        // Tracking rules are keyed on the original host, so strip params first
        // and only then swap the host.
        if (clearTrackingParams) out = clearTracking(out);
        if (fixEmbeds && !bracket) out = fixEmbedHost(out);
        return bracket + out;
    });
}

// ---------------------------------------------------------------------------
// Wording (PolishWording)
// ---------------------------------------------------------------------------

// Injecting apostrophe as well as contraction expansion rely on this mapping
const contractionsMap: { [key: string]: string; } = {
    "wasn't": "was not",
    "can't": "cannot",
    "don't": "do not",
    "won't": "will not",
    "isn't": "is not",
    "aren't": "are not",
    "haven't": "have not",
    "hasn't": "has not",
    "hadn't": "had not",
    "doesn't": "does not",
    "didn't": "did not",
    "shouldn't": "should not",
    "wouldn't": "would not",
    "couldn't": "could not",
    "that's": "that is",
    "what's": "what is",
    "there's": "there is",
    "how's": "how is",
    "where's": "where is",
    "when's": "when is",
    "who's": "who is",
    "why's": "why is",
    "you'll": "you will",
    "i'll": "I will",
    "they'll": "they will",
    "it'll": "it will",
    "i'm": "I am",
    "you're": "you are",
    "they're": "they are",
    "he's": "he is",
    "she's": "she is",
    "i've": "I have",
    "you've": "you have",
    "we've": "we have",
    "they've": "they have",
    "you'd": "you would",
    "he'd": "he would",
    "she'd": "she would",
    "it'd": "it would",
    "we'd": "we would",
    "they'd": "they would",
    "y'all": "you all",
    "here's": "here is",
};

const missingApostropheMap: { [key: string]: string; } = {};
for (const contraction in contractionsMap) {
    missingApostropheMap[contraction.toLowerCase().replace(/'/g, "")] = contraction;
}

const missingApostropheRegex = new RegExp(`\\b(${Object.keys(missingApostropheMap).join("|")})\\b`, "gi");
const contractionRegex = new RegExp(`\\b(${Object.keys(contractionsMap).join("|")})\\b`, "gi");

function getCapData(str: string) {
    const booleanArray: boolean[] = [];
    for (const char of str) {
        if (char.match(/[a-zA-Z]/)) { // Only record capitalization for letters
            booleanArray.push(char === char.toUpperCase());
        }
    }
    return booleanArray;
}

function restoreCap(str: string, data: boolean[]): string {
    let resultString = "";
    let dataIndex = 0;

    for (let i = 0; i < str.length; i++) {
        const char = str[i];
        if (!char.match(/[a-zA-Z]/)) {
            resultString += char;
            continue;
        }

        const isUppercase = data[dataIndex];
        resultString += isUppercase ? char.toUpperCase() : char.toLowerCase();

        // Increment index unless the data is shorter than the string, in which case we use the most recent for the rest
        if (dataIndex < data.length - 1) dataIndex++;
    }

    return resultString;
}

function ensureApostrophe(textInput: string): string {
    return textInput.replace(missingApostropheRegex, match => {
        const lowerCaseMatch = match.toLowerCase();
        if (Object.prototype.hasOwnProperty.call(missingApostropheMap, lowerCaseMatch)) {
            return restoreCap(missingApostropheMap[lowerCaseMatch], getCapData(match));
        }
        return match;
    });
}

function expandContractions(textInput: string) {
    return textInput.replace(contractionRegex, match => {
        const lowerCaseMatch = match.toLowerCase();
        if (Object.prototype.hasOwnProperty.call(contractionsMap, lowerCaseMatch)) {
            return restoreCap(contractionsMap[lowerCaseMatch], getCapData(match));
        }
        return match;
    });
}

function capitalize(textInput: string): string {
    // Regex modified from several stack overflows, if you change make sure it's safe against https://devina.io/redos-checker
    const sentenceSplitRegex = /((?<!\w\.\w.)(?<!\b[A-Z][a-z]\.)(?<![A-Z]\.)(?<!\.)(?<=[.?!])\s+|\n+)/;

    const parts = textInput.split(sentenceSplitRegex).filter(part => part !== undefined && part !== null);

    const blockedWordsArray = settings.store.blockedWords
        .split(/,\s?/)
        .filter(bw => bw)
        .map(bw => bw.toLowerCase());

    // Process alternating content and delimiters
    let result = "";
    for (const element of parts) {
        const isSentence = !sentenceSplitRegex.test(element); // if it matches the delimiter regex, it's a delimiter

        if (!isSentence) {
            // This is a delimiter (whitespace/newline), so add it back to reconstruct without being lossy
            if (element) result += element;
            continue;
        }

        if (!element) continue;
        if (element.trim() === "") {
            result += element;
            continue;
        }

        // Find the first actual word character for capitalization check
        const firstWordMatch = element.match(/^\s*([\w'-]+)/);
        const firstWord = firstWordMatch ? firstWordMatch[1].toLowerCase() : "";
        const isBlocked = firstWord ? blockedWordsArray.includes(firstWord) : false;

        if (!isBlocked && !element.startsWith("http")) { // Don't break links
            // Capitalize the first non-whitespace character (sentence splits can include newlines etc)
            result += element.replace(/^(\s*)(\S)/, (_, leadingSpace, firstChar) => leadingSpace + firstChar.toUpperCase());
        } else {
            result += element;
        }
    }

    return result.replace(/\bi\b(?!\s+is\b)(?=['\s]|$)/g, "I");
}

function addPeriods(textInput: string) {
    if (!textInput) return "";

    const urlRegex = /https?:\/\/\S+$|www\.\S+$/;
    const lines = textInput.split("\n");
    const processedLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        const strippedLine = lines[i].trimEnd();

        if (!strippedLine) {
            if (i < lines.length - 1) processedLines.push("");
            continue;
        }

        const lastChar = strippedLine.slice(-1);
        if (
            /[A-Za-z0-9]/.test(lastChar) && // If it doesn't already end with punctuation
            !urlRegex.test(strippedLine) // If it doesn't end with a link
        ) {
            processedLines.push(strippedLine + ".");
        } else {
            processedLines.push(strippedLine);
        }
    }

    return processedLines.join("\n");
}

function processWording(text: string): string {
    const { fixApostrophes, expandContractions: expand, fixCapitalization, fixPunctuation, fixPunctuationFrequency } = settings.store;

    // Note: if expanding contractions, fix them first.
    if (fixApostrophes || expand) text = ensureApostrophe(text);
    if (fixCapitalization) text = capitalize(text);
    if (fixPunctuation && (Math.random() * 100 < fixPunctuationFrequency)) text = addPeriods(text);
    if (expand) text = expandContractions(text);

    return text;
}

// ---------------------------------------------------------------------------
// Typing style (TypingStyles)
// ---------------------------------------------------------------------------

type TypingStyle = "off" | "lowercase" | "uppercase" | "titlecase" | "sentencecase" | "alternating";

// Tokens that must be left exactly as typed. Changing the case of any of these
// either breaks the link or stops Discord from resolving the mention/emoji.
const PROTECTED_TOKEN = [
    /[a-z][a-z0-9+.-]*:\/\//i, // any link with a scheme, even quoted or bracketed: https://…, <https://…>, ("https://…")
    /(?:^|\W)www\./i, // schemeless links: www.example.com
    /^<[@#a-z:]/i, // mentions and custom emoji: <@123>, <#123>, <:name:id>, <a:name:id>
    /^:[a-z0-9_+-]+:$/i, // shortcode emoji: :smile:
    /[^\s@]+@[^\s@]+\.[a-z]{2,}/i, // email addresses: bob@example.com
    /__CODE_BLOCK_\d+__/i, // placeholders for code carved out of the message
];

function isProtected(token: string): boolean {
    return PROTECTED_TOKEN.some(re => re.test(token));
}

// Uppercases the first *letter* rather than the first character, so leading
// quotes, brackets and markdown get stepped over instead of swallowing the
// capitalisation: '"hi there"' -> '"Hi there"', "**hi**" -> "**Hi**".
function capitalizeFirstLetter(token: string): string {
    return token.replace(/\p{L}/u, letter => letter.toUpperCase());
}

// Pronoun "I" and its contractions stay capitalised in sentence case.
const PRONOUN_I = /^(\W*)i(?=$|\W|'(?:m|ll|ve|d)\b)/iu;

function endsSentence(token: string): boolean {
    return /[.!?…]["')\]]*$/.test(token);
}

function restyle(text: string, style: TypingStyle): string {
    if (style === "off") return text;

    // Walk the message as an alternating stream of whitespace and tokens so
    // the styles that need context (sentence starts, letter parity) have it.
    let startOfSentence = true;
    let letterIndex = 0;

    return text.replace(/\s+|\S+/g, token => {
        if (/^\s+$/.test(token)) {
            if (token.includes("\n")) startOfSentence = true;
            return token;
        }
        if (isProtected(token)) {
            startOfSentence = endsSentence(token);
            return token;
        }

        let out: string;
        switch (style) {
            case "lowercase":
                out = token.toLowerCase();
                break;
            case "uppercase":
                out = token.toUpperCase();
                break;
            case "titlecase":
                out = capitalizeFirstLetter(token);
                break;
            case "sentencecase":
                out = token.toLowerCase().replace(PRONOUN_I, "$1I");
                if (startOfSentence) out = capitalizeFirstLetter(out);
                break;
            case "alternating":
                out = token.replace(/\p{L}/gu, letter =>
                    letterIndex++ % 2 === 0 ? letter.toLowerCase() : letter.toUpperCase()
                );
                break;
        }
        startOfSentence = endsSentence(token);
        return out;
    });
}

// ---------------------------------------------------------------------------
// Message pipeline
// ---------------------------------------------------------------------------

const CODE_BLOCK_REGEX = /```[\s\S]*?```|`[\s\S]*?`/g;

function processMessage(input: string): string {
    // Quick disable, without having to reload the client
    if (settings.store.quickDisable) return input;

    // Preserve code blocks
    const codeBlocks: string[] = [];
    let text = input.replace(CODE_BLOCK_REGEX, match => {
        codeBlocks.push(match);
        return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
    });

    text = processLinks(text);
    text = processWording(text);
    text = restyle(text, settings.store.typingStyle as TypingStyle);

    // Case-insensitive: a style may have restyled the placeholder itself.
    return text.replace(/__CODE_BLOCK_(\d+)__/gi, (_, index) => codeBlocks[parseInt(index)]);
}

function onMessage(msg: MessageObject) {
    msg.content = processMessage(msg.content);
}

export default definePlugin({
    name: "BetterTyping",
    description: "Cleans tracking parameters from links, rewrites them to embed-fixing mirrors (fxspotify, fxapplemusic, fxtwitter, ...), polishes your wording and restyles your typing (lowercase, Title Case, ...). See settings.",
    dependencies: ["MessageEventsAPI"],
    tags: ["Chat", "Privacy", "Utility"],
    authors: [
        { name: "xocat", id: 1525464078783615083n },
        Devs.adryd,
        Devs.thororen,
        Devs.Samwich,
        EquicordDevs.WKoA,
    ],
    settings,

    async start() {
        await Promise.all([
            createRules().catch(e =>
                logger.error("Failed to fetch ClearURLs rules; tracking parameters will not be stripped", e)
            ),
            loadTlds().catch(e =>
                logger.error("Failed to fetch IANA TLD list; using the built-in fallback for linkifying", e)
            ),
        ]);
    },

    stop() {
        rules = [];
    },

    onBeforeMessageSend(_, msg) {
        onMessage(msg);
    },

    onBeforeMessageEdit(_cid, _mid, msg) {
        onMessage(msg);
    },
});
