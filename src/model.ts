/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Application state: the hosts ("agents") we manage and their stacks.
 * Replaces Dockge's socket.io stack list broadcasts with polling.
 */

import { useEffect, useState } from 'react';

import cockpit from 'cockpit';

import * as docker from './docker';
import type { Host, Settings, StackInfo, Agent } from './docker';
import { hostnameOf } from './util';

const _ = cockpit.gettext;

export const POLL_INTERVAL = 5000;

export type HostStatus = "connecting" | "online" | "offline";

export interface HostState {
    host: Host;
    status: HostStatus;
    error: string | null;
    settings: Settings | null;
    stacks: StackInfo[] | null;
}

export class Model {
    localSettings: Settings | null = null;
    localSettingsError: string | null = null;
    hosts = new Map<Host, HostState>();
    listeners = new Set<() => void>();
    version = 0;
    #timer: number | null = null;
    #refreshing = new Set<Host>();

    notify() {
        this.version++;
        this.listeners.forEach(l => l());
    }

    async init() {
        try {
            this.localSettings = await docker.loadSettings("");
        } catch (ex) {
            this.localSettingsError = docker.errorMessage(ex);
            this.localSettings = { ...docker.defaultSettings, agents: [] };
        }
        this.#syncHosts();
        await this.refreshAll();
        if (this.#timer === null)
            this.#timer = window.setInterval(() => {
                if (document.visibilityState === "visible")
                    this.refreshAll();
            }, POLL_INTERVAL);
    }

    close() {
        if (this.#timer !== null)
            window.clearInterval(this.#timer);
        this.#timer = null;
    }

    get agents(): Agent[] {
        return this.localSettings?.agents ?? [];
    }

    /** All hosts, the local machine first */
    get hostList(): Host[] {
        return ["", ...this.agents.map(a => a.host)];
    }

    #syncHosts() {
        const wanted = new Set(this.hostList);
        for (const host of [...this.hosts.keys()])
            if (!wanted.has(host))
                this.hosts.delete(host);
        for (const host of wanted)
            if (!this.hosts.has(host))
                this.hosts.set(host, { host, status: "connecting", error: null, settings: null, stacks: null });
        this.notify();
    }

    async refreshAll() {
        await Promise.all(this.hostList.map(h => this.refresh(h)));
    }

    async refresh(host: Host) {
        if (this.#refreshing.has(host))
            return;
        const state = this.hosts.get(host);
        if (!state)
            return;
        this.#refreshing.add(host);
        try {
            if (host === "")
                state.settings = this.localSettings;
            else if (!state.settings)
                state.settings = await docker.loadSettings(host);
            state.stacks = await docker.listStacks(host, state.settings as Settings);
            state.status = "online";
            state.error = null;
        } catch (ex) {
            state.status = "offline";
            state.error = docker.errorMessage(ex);
            if (host !== "")
                state.settings = null; // reload once the host comes back
        } finally {
            this.#refreshing.delete(host);
        }
        this.notify();
    }

    settingsFor(host: Host): Settings | null {
        return this.hosts.get(host)?.settings ?? null;
    }

    findStack(host: Host, name: string): StackInfo | undefined {
        return this.hosts.get(host)?.stacks?.find(s => s.name === name);
    }

    allStacks(): StackInfo[] {
        const all: StackInfo[] = [];
        for (const h of this.hosts.values())
            all.push(...(h.stacks ?? []));
        return all;
    }

    hostDisplayName(host: Host): string {
        if (host === "")
            return _("This machine");
        const agent = this.agents.find(a => a.host === host);
        return agent?.name || host;
    }

    /** Hostname used for links to published ports */
    hostnameFor(host: Host): string {
        const settings = this.settingsFor(host);
        if (settings?.primaryHostname)
            return settings.primaryHostname;
        return hostnameOf(host, window.location.hostname || "localhost");
    }

    async saveLocalSettings(settings: Settings) {
        await docker.saveSettings("", settings);
        this.localSettings = settings;
        const local = this.hosts.get("");
        if (local)
            local.settings = settings;
        this.#syncHosts();
        await this.refreshAll();
    }

    /** Save settings of an agent host (stacks directory, primary hostname, console) */
    async saveHostSettings(host: Host, settings: Settings) {
        if (host === "")
            return this.saveLocalSettings(settings);
        await docker.saveSettings(host, settings);
        const state = this.hosts.get(host);
        if (state)
            state.settings = settings;
        await this.refresh(host);
    }

    async addAgent(agent: Agent) {
        if (!this.localSettings)
            throw new Error("Settings not loaded");
        const host = agent.host.trim();
        if (host === "" || host === "localhost")
            throw new Error(_("This machine is always managed"));
        if (this.agents.some(a => a.host === host))
            throw new Error(_("This host has already been added"));
        // Check that we can reach docker there before saving
        await docker.checkDocker(host);
        await this.saveLocalSettings({ ...this.localSettings, agents: [...this.agents, { host, name: agent.name.trim() }] });
    }

    async removeAgent(host: Host) {
        if (!this.localSettings)
            return;
        await this.saveLocalSettings({ ...this.localSettings, agents: this.agents.filter(a => a.host !== host) });
    }

    async renameAgent(host: Host, name: string) {
        if (!this.localSettings)
            return;
        await this.saveLocalSettings({
            ...this.localSettings,
            agents: this.agents.map(a => a.host === host ? { ...a, name: name.trim() } : a),
        });
    }
}

export function useModel(model: Model): number {
    const [version, setVersion] = useState(model.version);
    useEffect(() => {
        const update = () => setVersion(model.version);
        model.listeners.add(update);
        return () => { model.listeners.delete(update) };
    }, [model]);
    return version;
}

/** Location helpers; all pages carry the host as an option, like Cockpit's own pages */
export function goto(path: string[], host: Host, extra: Record<string, string> = {}) {
    const options: Record<string, string> = { ...extra };
    if (host)
        options.host = host;
    cockpit.location.go(path, options);
}

/** Compose template handed from "Convert to compose" to the new stack page */
export const pendingTemplate: { composeYAML: string | null } = { composeYAML: null };
