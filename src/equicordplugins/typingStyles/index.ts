/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addMessagePreSendListener, removeMessagePreSendListener } from "@api/MessageEvents";
import { definePluginSettings } from "@api/Settings";
import { EquicordDevs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";

type TypingStyle = "off" | "lowercase" | "uppercase" | "titlecase" | "sentencecase" | "alternating";

const settings = definePluginSettings({
    style: {
        type: OptionType.SELECT,
        description: "How your messages should look. Links, mentions, emoji, emails and code are never touched.",
        options: [
            { label: "Off (send as typed)", value: "off" },
            { label: "lowercase — \"hi wats going on\"", value: "lowercase" },
            { label: "UPPERCASE — \"HI WATS GOING ON\"", value: "uppercase" },
            { label: "Title Case — \"Hi Wats Going On\"", value: "titlecase", default: true },
            { label: "Sentence case — \"Hi wats going on. Ok\"", value: "sentencecase" },
            { label: "aLtErNaTiNg — \"hI wAtS gOiNg On\"", value: "alternating" },
        ],
    },
});

// Tokens that must be left exactly as typed. Changing the case of any of these
// either breaks the link or stops Discord from resolving the mention/emoji.
const PROTECTED_TOKEN = [
    /[a-z][a-z0-9+.-]*:\/\//i, // any link with a scheme, even quoted or bracketed: https://…, <https://…>, ("https://…")
    /(?:^|\W)www\./i, // schemeless links: www.example.com
    /^<[@#a-z:]/i, // mentions and custom emoji: <@123>, <#123>, <:name:id>, <a:name:id>
    /^:[a-z0-9_+-]+:$/i, // shortcode emoji: :smile:
    /[^\s@]+@[^\s@]+\.[a-z]{2,}/i, // email addresses: bob@example.com
];

// Code must survive exactly as typed, and unlike the tokens above it can span
// whitespace, so it has to be carved out before the message is split on spaces.
// Longest fence first, otherwise the single-backtick branch eats part of a ```
// fence. The capture group makes String#split interleave these spans into the
// result at odd indices.
const CODE_SPAN = /(```[\s\S]*?```|``[\s\S]*?``|`[^`\n]*`)/g;

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

function restyleWords(text: string, style: TypingStyle): string {
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

        let out = token;
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

export function restyle(text: string, style: TypingStyle): string {
    if (style === "off") return text;
    return text
        .split(CODE_SPAN)
        .map((part, i) => i % 2 === 1 ? part : restyleWords(part, style))
        .join("");
}

export default definePlugin({
    name: "TypingStyles",
    description: "Restyles every message you send: lowercase, UPPERCASE, Title Case, Sentence case or aLtErNaTiNg",
    authors: [EquicordDevs.xocat],
    settings,

    start() {
        this.preSend = (_channelId: string, messageObj: { content: string; }) => {
            messageObj.content = restyle(messageObj.content, settings.store.style as TypingStyle);
        };
        addMessagePreSendListener(this.preSend);
    },

    stop() {
        removeMessagePreSendListener(this.preSend);
    },
});
