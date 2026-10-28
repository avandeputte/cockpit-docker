/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Terminal views on top of Cockpit's xterm.js terminal component:
 * read-only output (progress of compose actions, combined logs) and
 * interactive shells (container exec, stacks directory console).
 */

import React, { useEffect, useRef, useState } from 'react';

import { Terminal, TerminalState } from "cockpit-components-terminal.jsx";
import cockpit from 'cockpit';

import "./Terminals.scss";

/** Checks whether xterm.js' WebGL renderer, which Cockpit's terminal requires, can work in this browser */
export function canUseTerminal(): boolean {
    try {
        return !!document.createElement("canvas").getContext("webgl2");
    } catch {
        return false;
    }
}

function readOnlyState(channel: cockpit.Channel<string>): TerminalState {
    const state = new TerminalState(channel);
    state.terminal.options.disableStdin = true;
    state.terminal.options.cursorBlink = false;
    state.terminal.options.fontSize = 13;
    state.terminal.options.scrollback = 5000;
    return state;
}

/**
 * Shows the output of a channel that is (re)opened whenever `channelKey` changes.
 * Used for "docker compose logs -f".
 */
export const OutputTerminal = ({ id, openChannel, channelKey, height }: {
    id: string,
    openChannel: () => cockpit.Channel<string>,
    channelKey: string,
    height: string,
}) => {
    const [state, setState] = useState<TerminalState | null>(null);

    useEffect(() => {
        const s = readOnlyState(openChannel());
        setState(s);
        return () => s.close();
        // openChannel is expected to change together with channelKey
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [channelKey]);

    return (
        <div id={id} className="ct-output-terminal" style={{ height }}>
            {state && <Terminal parentId={id} state={state} />}
        </div>
    );
};

/**
 * Terminal for the output of stack actions (deploy, start, update, ...).
 * Call run() with a freshly opened channel; output of previous runs is cleared.
 */
export class ProgressTerminalState {
    state: TerminalState | null = null;
    listeners = new Set<() => void>();

    run(channel: cockpit.Channel<string>) {
        if (this.state) {
            this.state.resetChannel(channel);
            const t = this.state.terminal;
            channel.control({ window: { rows: t.rows, cols: t.cols } } as cockpit.JsonObject as cockpit.ControlMessage);
        } else {
            this.state = readOnlyState(channel);
        }
        this.listeners.forEach(l => l());
    }

    close() {
        this.state?.close();
        this.state = null;
    }
}

export const ProgressTerminal = ({ id, progress, height }: { id: string, progress: ProgressTerminalState, height: string }) => {
    const [, setTick] = useState(0);

    useEffect(() => {
        const update = () => setTick(t => t + 1);
        progress.listeners.add(update);
        return () => { progress.listeners.delete(update) };
    }, [progress]);

    if (!progress.state)
        return null;

    return (
        <div id={id} className="ct-output-terminal" style={{ height }}>
            <Terminal parentId={id} state={progress.state} />
        </div>
    );
};

/** An interactive shell; reconnects when `channelKey` changes */
export const InteractiveTerminal = ({ id, openChannel, channelKey, height }: {
    id: string,
    openChannel: () => cockpit.Channel<string>,
    channelKey: string,
    height: string,
}) => {
    const ref = useRef<Terminal>(null);
    const [channel, setChannel] = useState<cockpit.Channel<string> | null>(null);

    useEffect(() => {
        const c = openChannel();
        setChannel(c);
        return () => c.close();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [channelKey]);

    useEffect(() => {
        if (channel)
            window.setTimeout(() => ref.current?.focus(), 0);
    }, [channel]);

    return (
        <div id={id} className="ct-interactive-terminal" style={{ height }}>
            {channel && <Terminal ref={ref} parentId={id} channel={channel} />}
        </div>
    );
};
