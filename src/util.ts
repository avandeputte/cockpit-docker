/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Pure helpers shared by the UI and the unit tests. Nothing in here may
 * import "cockpit", so that it can run under node.
 *
 * Several helpers are ported from Dockge (common/util-common.ts),
 * Copyright (c) 2023 Louis Lam, MIT licensed.
 */

import composerize from "composerize";
import { Document, Pair, YAMLMap, YAMLSeq, parseDocument, isMap, isSeq, isScalar, visit } from "yaml";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type LooseObject = Record<string, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

// Stack status, same values as Dockge
export const UNKNOWN = 0;
export const CREATED_FILE = 1;
export const CREATED_STACK = 2;
export const RUNNING = 3;
export const EXITED = 4;

export type StackStatus = typeof UNKNOWN | typeof CREATED_FILE | typeof CREATED_STACK | typeof RUNNING | typeof EXITED;

export type StatusFilter = "all" | "active" | "exited" | "inactive";

export const acceptedComposeFileNames = [
    "compose.yaml",
    "docker-compose.yaml",
    "docker-compose.yml",
    "compose.yml",
];

export const DEFAULT_STACKS_DIR = "/opt/stacks";

export const defaultComposeTemplate = `services:
  nginx:
    image: nginx:latest
    restart: unless-stopped
    ports:
      - "8080:80"
`;

export const defaultEnvTemplate = "# VARIABLE=value #comment\n";

/**
 * Convert the status string from `docker compose ls` to a status number.
 * Input example: "exited(1), running(1)"
 */
export function statusConvert(status: string): StackStatus {
    if (status.startsWith("created")) {
        return CREATED_STACK;
    } else if (status.includes("exited")) {
        // If one of the services exited, consider the stack exited
        return EXITED;
    } else if (status.startsWith("running")) {
        return RUNNING;
    } else {
        return UNKNOWN;
    }
}

/** Short status class used for filtering and counting: active, exited, inactive or unknown */
export function statusClass(status: StackStatus): "active" | "exited" | "inactive" | "unknown" {
    switch (status) {
    case RUNNING:
        return "active";
    case EXITED:
        return "exited";
    case CREATED_FILE:
    case CREATED_STACK:
        return "inactive";
    default:
        return "unknown";
    }
}

export function matchesStatusFilter(status: StackStatus, filter: StatusFilter): boolean {
    if (filter === "all")
        return true;
    return statusClass(status) === filter;
}

/** Returns an error message, or null when the stack name is valid */
export function validateStackName(name: string): string | null {
    if (!name)
        return "Stack name must not be empty";
    if (!/^[a-z0-9_-]+$/.test(name))
        return "Stack name can only contain [a-z][0-9] _ - only";
    return null;
}

/** Returns an error message, or null when the .env content can be consumed by docker compose */
export function validateEnv(env: string): string | null {
    const lines = env.split("\n");
    // Prevent "setenv: The parameter is incorrect": a single line without "="
    if (lines.length === 1 && !lines[0].includes("=") && lines[0].length > 0)
        return "Invalid .env format";
    return null;
}

/**
 * Parse a .env file the way dotenv does: KEY=VALUE, optional "export ",
 * single, double or back quoted values, and trailing # comments on unquoted values.
 */
export function parseDotenv(content: string): Record<string, string> {
    const result: Record<string, string> = {};
    const re = /^\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?$/mg;
    const lines = content.replace(/\r\n?/g, "\n");
    let match;
    while ((match = re.exec(lines)) !== null) {
        const key = match[1];
        let value = (match[2] || "").trim();
        const quote = value[0];
        value = value.replace(/^(['"`])([\s\S]*)\1$/m, "$2");
        if (quote === '"')
            value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
        result[key] = value;
    }
    return result;
}

/**
 * Substitute ${VAR}, ${VAR:-default}, ${VAR-default}, ${VAR:?err}, ${VAR?err} and $VAR,
 * like docker compose does. "$$" is an escaped "$".
 */
export function envsubst(input: string, variables: Record<string, string | undefined>): string {
    return input.replace(/\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])((?:[^{}]|\{[^{}]*\})*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
                         (whole, braced, op, arg, plain) => {
                             if (whole === "$$")
                                 return "$$";
                             const name = braced || plain;
                             const value = variables[name];
                             if (!op)
                                 return value ?? "";
                             const unsetOrEmpty = op.startsWith(":") ? !value : value === undefined;
                             if (op.endsWith("-"))
                                 return unsetOrEmpty ? envsubst(arg, variables) : (value ?? "");
                             if (op.endsWith("+"))
                                 return unsetOrEmpty ? "" : envsubst(arg, variables);
                             // "?" variants: keep the reference visible when missing
                             return unsetOrEmpty ? "" : (value ?? "");
                         });
}

function traverseYAML(node: unknown, env: Record<string, string>): void {
    if (isMap(node) || isSeq(node)) {
        for (const item of (node as YAMLMap | YAMLSeq).items) {
            if (item instanceof Pair) {
                if (isScalar(item.value) && typeof item.value.value === "string")
                    item.value.value = envsubst(item.value.value, env);
                else
                    traverseYAML(item.value, env);
            } else if (isScalar(item) && typeof item.value === "string") {
                item.value = envsubst(item.value, env);
            } else {
                traverseYAML(item, env);
            }
        }
    }
}

/**
 * Replace environment variables in all values of a compose YAML document,
 * emulating how docker compose handles variables.
 */
export function envsubstYAML(content: string, env: Record<string, string>): string {
    const doc = parseDocument(content);
    traverseYAML(doc.contents, env);
    return doc.toString();
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function nodeKey(node: any): string {
    return isScalar(node) ? String(node.value) : JSON.stringify(node?.toJSON?.() ?? node);
}

function copyNodeComments(node: any, src: any) {
    if (!node || !src || typeof node !== "object" || typeof src !== "object")
        return;
    if (src.commentBefore !== undefined)
        node.commentBefore = src.commentBefore;
    if (src.comment !== undefined)
        node.comment = src.comment;
    if (src.spaceBefore)
        node.spaceBefore = src.spaceBefore;
    // keep the quoting style of unchanged values
    if (isScalar(node) && isScalar(src) && node.value === src.value && src.type)
        node.type = src.type;

    if (isMap(node) && isMap(src)) {
        for (const pair of node.items as any[]) {
            const key = nodeKey(pair.key);
            const srcPair = (src.items as any[]).find(p => nodeKey(p.key) === key);
            if (!srcPair)
                continue;
            copyNodeComments(pair.key, srcPair.key);
            copyNodeComments(pair.value, srcPair.value);
        }
    } else if (isSeq(node) && isSeq(src)) {
        const used = new Set<number>();
        (node.items as any[]).forEach((item, idx) => {
            // match by content first, then by position
            let srcIdx = (src.items as any[]).findIndex((s, i) => !used.has(i) && nodeKey(s) === nodeKey(item));
            if (srcIdx === -1 && idx < src.items.length && !used.has(idx))
                srcIdx = idx;
            if (srcIdx === -1)
                return;
            used.add(srcIdx);
            copyNodeComments(item, src.items[srcIdx]);
        });
    }
}

/** Copy comments from `src` to `doc`, so that edits made through forms keep the user's comments */
export function copyYAMLComments(doc: Document, src: Document) {
    doc.comment = src.comment;
    doc.commentBefore = src.commentBefore;
    copyNodeComments(doc.contents, src.contents);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface ParsedCompose {
    config: LooseObject;
    doc: Document;
}

/** Parse compose YAML; throws on syntax errors or when "services" is not a mapping */
export function parseCompose(yamlText: string): ParsedCompose {
    const doc = parseDocument(yamlText);
    if (doc.errors.length > 0)
        throw doc.errors[0];
    const config = (doc.toJS() ?? {}) as LooseObject;
    if (typeof config !== "object" || Array.isArray(config))
        throw new Error("The compose file must be a mapping");
    if (!config.services)
        config.services = {};
    if (Array.isArray(config.services) || typeof config.services !== "object")
        throw new Error("Services must be an object");
    return { config, doc };
}

/** Serialize a config object back to YAML, keeping comments from the previous document */
export function composeToYAML(config: LooseObject, previous: Document | null): { yaml: string, doc: Document } {
    const doc = new Document(config);
    if (previous)
        copyYAMLComments(doc, previous);
    // "8080:80" must stay quoted, YAML 1.1 parsers read unquoted xx:yy as base 60 numbers
    visit(doc, {
        Scalar(_key, node) {
            if (typeof node.value === "string" && /^[0-9.]+(:[0-9.-]+)+(\/\w+)?$/.test(node.value) && !node.type?.startsWith("QUOTE"))
                node.type = "QUOTE_DOUBLE";
        },
    });
    return { yaml: doc.toString(), doc };
}

export interface PortLink {
    url: string;
    display: string;
}

/**
 * Turn a compose/`docker ps` port definition into a link.
 * Possible inputs: "3000", "3000-3005", "8000:8000", "9090-9091:8080-8081",
 * "127.0.0.1:8001:8001", "0.0.0.0:8080->8080/tcp", "6060:6060/udp",
 * or the long syntax { published, target, host_ip, protocol }.
 */
export function parseDockerPort(input: string | number | LooseObject, hostname: string): PortLink {
    if (typeof input === "object" && input !== null) {
        const published = input.published ?? input.target;
        const host = input.host_ip && input.host_ip !== "0.0.0.0" ? input.host_ip : hostname;
        const str = String(published) + (input.protocol ? "/" + input.protocol : "");
        return parseDockerPort(str, host);
    }

    let port: string;
    let display: string;

    const parts = String(input).split("/");
    let part1 = parts[0];
    let protocol = parts[1] || "tcp";

    // Coming from docker ps: split the host part
    if (part1.includes("->")) {
        part1 = part1.split("->")[0];
        if (part1.includes(":"))
            part1 = part1.substring(part1.lastIndexOf(":") + 1);
    }

    const lastColon = part1.lastIndexOf(":");
    if (lastColon === -1) {
        // Just a port or port range
        const dash = part1.indexOf("-");
        port = dash === -1 ? part1 : part1.substring(0, dash);
        display = part1;
    } else {
        // Port mapping
        let hostPart = part1.substring(0, lastColon);
        display = hostPart;
        const dash = hostPart.indexOf("-");
        if (dash !== -1)
            hostPart = hostPart.substring(0, dash);
        const colon = hostPart.lastIndexOf(":");
        if (colon !== -1) {
            const ip = hostPart.substring(0, colon);
            if (ip !== "0.0.0.0" && ip !== "")
                hostname = ip;
            port = hostPart.substring(colon + 1);
        } else {
            port = hostPart;
        }
    }

    const portInt = parseInt(port);
    if (portInt === 443)
        protocol = "https";
    else if (protocol === "tcp")
        protocol = "http";

    return {
        url: protocol + "://" + hostname + ":" + portInt,
        display,
    };
}

/** The "x-dockge: urls:" links of a stack */
export function stackUrls(config: LooseObject): PortLink[] {
    const urls = config?.["x-dockge"]?.urls;
    if (!Array.isArray(urls))
        return [];
    return urls.filter(u => typeof u === "string" && u !== "").map((url: string) => {
        let display;
        try {
            const obj = new URL(url);
            const pathname = obj.pathname === "/" ? "" : obj.pathname;
            display = obj.host + pathname + obj.search;
        } catch {
            display = url;
        }
        return { url, display };
    });
}

export function splitImage(image: string | undefined): { name: string, tag: string } {
    if (!image)
        return { name: "", tag: "" };
    // a registry with port ("host:5000/img") must not be taken as a tag
    const at = image.indexOf("@");
    if (at !== -1)
        return { name: image.substring(0, at), tag: image.substring(at + 1) };
    const slash = image.lastIndexOf("/");
    const colon = image.lastIndexOf(":");
    if (colon > slash)
        return { name: image.substring(0, colon), tag: image.substring(colon + 1) };
    return { name: image, tag: "latest" };
}

export interface ServiceInstance {
    name: string;
    status: string;
}

/**
 * Parse `docker compose ps --format json`, which prints either one JSON object
 * per line (newer compose) or a single array (older compose).
 * Returns service name → container instances.
 */
export function parseComposePs(stdout: string): Record<string, ServiceInstance[]> {
    const result: Record<string, ServiceInstance[]> = {};
    const add = (obj: LooseObject) => {
        if (!obj?.Service)
            return;
        (result[obj.Service] ??= []).push({ status: obj.Health || obj.State, name: obj.Name });
    };
    for (const line of stdout.split("\n")) {
        if (!line.trim())
            continue;
        try {
            const obj = JSON.parse(line);
            if (Array.isArray(obj))
                obj.forEach(add);
            else
                add(obj);
        } catch {
            // ignore non-JSON lines (warnings)
        }
    }
    return result;
}

/** Parse JSON output that is either an array or one object per line */
export function parseJSONLines(stdout: string): LooseObject[] {
    const out: LooseObject[] = [];
    for (const line of stdout.split("\n")) {
        if (!line.trim())
            continue;
        try {
            const obj = JSON.parse(line);
            if (Array.isArray(obj))
                out.push(...obj);
            else
                out.push(obj);
        } catch {
            // ignore
        }
    }
    return out;
}

export interface ContainerStats {
    Name: string;
    CPUPerc: string;
    MemUsage: string;
    MemPerc: string;
    NetIO: string;
    BlockIO: string;
    PIDs: string;
}

/** Parse `docker stats --no-stream --format json` into a map keyed by container name */
export function parseDockerStats(stdout: string): Record<string, ContainerStats> {
    const result: Record<string, ContainerStats> = {};
    for (const obj of parseJSONLines(stdout)) {
        if (obj.Name)
            result[obj.Name] = obj as ContainerStats;
    }
    return result;
}

/* Volumes: "SOURCE:TARGET[:MODE]", or just "TARGET" for an anonymous volume */

export interface VolumeSpec {
    /** Host path (bind mount) or volume name; empty for an anonymous volume */
    source: string;
    target: string;
    /** For example "ro", "rw", "ro,z" */
    mode: string;
}

export function parseVolume(volume: string): VolumeSpec {
    const parts = volume.split(":");
    if (parts.length === 1)
        return { source: "", target: parts[0], mode: "" };
    return { source: parts[0], target: parts[1], mode: parts.slice(2).join(":") };
}

export function formatVolume({ source, target, mode }: VolumeSpec): string {
    if (source === "" && mode === "")
        return target;
    return source + ":" + target + (mode ? ":" + mode : "");
}

export function isReadOnlyMode(mode: string): boolean {
    return mode.split(",").includes("ro");
}

export function setReadOnlyMode(mode: string, readOnly: boolean): string {
    const flags = mode.split(",").filter(f => f !== "" && f !== "ro" && f !== "rw");
    return (readOnly ? ["ro", ...flags] : flags).join(",");
}

/** Bind mount sources are paths; anything else is the name of a volume */
export function isBindSource(source: string): boolean {
    return source.startsWith("/") || source.startsWith(".") || source.startsWith("~");
}

export function parentDirectory(path: string): string {
    const trimmed = path.replace(/\/+$/, "");
    const idx = trimmed.lastIndexOf("/");
    return idx <= 0 ? "/" : trimmed.substring(0, idx);
}

/** Absolute host path of a bind source; relative ones are relative to the stack directory */
export function resolveHostPath(source: string, stackDir: string): string {
    if (source.startsWith("/"))
        return source;
    if (source === "." || source.startsWith("./") || source.startsWith("../")) {
        const parts = stackDir.split("/").filter(p => p !== "");
        for (const p of source.split("/")) {
            if (p === "..")
                parts.pop();
            else if (p !== "." && p !== "")
                parts.push(p);
        }
        return "/" + parts.join("/");
    }
    return stackDir;
}

/** The bind source for a chosen directory: relative ("./data") inside the stack directory, else absolute */
export function bindSourceFor(path: string, stackDir: string): string {
    const dir = stackDir.replace(/\/+$/, "");
    if (dir && path === dir)
        return ".";
    if (dir && path.startsWith(dir + "/"))
        return "./" + path.substring(dir.length + 1);
    return path;
}

/** Hostname to use for port links of a host. "user@nas:2222" → "nas" */
export function hostnameOf(host: string, fallback: string): string {
    if (!host || host === "localhost")
        return fallback;
    let h = host.includes("@") ? host.substring(host.indexOf("@") + 1) : host;
    if (h.startsWith("[")) // IPv6 literal
        h = h.substring(1, h.indexOf("]"));
    else if (h.includes(":"))
        h = h.substring(0, h.indexOf(":"));
    return h;
}

/** Pick the stack name for a new stack when none was given, like Dockge: first service's container_name or name */
export function defaultStackName(config: LooseObject): string {
    const services = Object.keys(config?.services ?? {});
    if (services.length === 0)
        return "";
    const first = config.services[services[0]];
    return ((first && first.container_name) || services[0]).toLowerCase();
}

export function isRunningStatus(status: string | undefined): boolean {
    return status === "running" || status === "healthy";
}

/** Coerce a compose list-or-mapping field (environment, labels, ...) into a list of strings */
export function toStringList(value: unknown, sep = "="): string[] {
    if (Array.isArray(value))
        return value.map(v => typeof v === "object" ? JSON.stringify(v) : String(v));
    if (value && typeof value === "object")
        return Object.entries(value).map(([k, v]) => v === null || v === undefined ? k : `${k}${sep}${v}`);
    return [];
}

/** Networks of a service can be a list or a mapping */
export function serviceNetworks(value: unknown): string[] {
    if (Array.isArray(value))
        return value.map(String);
    if (value && typeof value === "object")
        return Object.keys(value);
    return [];
}

/** Convert a `docker run ...` command line into a compose file (without the leading "name:" line) */
export function dockerRunToCompose(command: string): string {
    const cmd = command.trim();
    if (cmd === "" || cmd === "docker run")
        throw new Error("Please enter a docker run command");
    const out: string = composerize(cmd, "", "latest");
    // Remove the top-level "name: <your project name>"; it is not always the first line
    return out.split("\n").filter(line => !line.startsWith("name:"))
            .join("\n");
}
