/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";

const KEY = "OllamaReplySuggest_memory";
const logger = new Logger("OllamaReplySuggest");

export interface MemoryEntry {
    id: string;
    name: string;
    content: string;
}

/**
 * Memory is kept twice over, under two kinds of key. A conversation scope is the flow of a
 * channel or DM, and a person scope is everything one person has said to you and everything
 * you said back, wherever they said it. A draft reads the person first, so someone who
 * follows you from server to server is still the same person to it.
 */
type Memory = Record<string, MemoryEntry[]>;

export function conversationScope(channelId: string) {
    return `channel:${channelId}`;
}

export function personScope(userId: string) {
    return `user:${userId}`;
}

let store: Memory = {};

export async function loadMemory() {
    try {
        store = await DataStore.get<Memory>(KEY) ?? {};
    } catch (e) {
        logger.error("Could not read what was remembered, starting empty", e);
        return;
    }

    // Memory written before scopes existed was keyed by channel id alone.
    for (const key of Object.keys(store)) {
        if (key.includes(":")) continue;

        store[conversationScope(key)] = store[key];
        delete store[key];
    }
}

function persist() {
    void DataStore.set(KEY, store).catch(e => logger.warn("Could not save memory", e));
}

/**
 * Files one message under every scope it belongs to, so it can be recalled by who said it
 * or by where it was said. Message ids are kept so a line that is still on screen is never
 * handed to the model twice.
 */
export function remember(scopes: string[], entry: MemoryEntry, limit: number) {
    if (limit === 0) return;

    for (const scope of scopes) {
        const entries = store[scope] ??= [];
        if (entries.some(e => e.id === entry.id)) continue;

        entries.push(entry);
        if (entries.length > limit) entries.splice(0, entries.length - limit);
    }

    persist();
}

export function recall(scope: string, limit: number): MemoryEntry[] {
    const entries = store[scope] ?? [];
    return limit === 0 ? [] : entries.slice(-limit);
}

export function rememberedScopes() {
    return Object.entries(store)
        .map(([scope, entries]) => ({ scope, count: entries.length }))
        .filter(({ count }) => count > 0);
}

export function forget(scope: string) {
    delete store[scope];
    persist();
}

export function forgetEverything() {
    store = {};
    persist();
}
