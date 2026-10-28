/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Access to Docker and the stacks directory on a host, through the Cockpit bridge.
 * This replaces Dockge's Node.js backend: every operation is a process spawned
 * with cockpit.spawn() or a stream channel, optionally on another host
 * ("agent") that Cockpit can reach over SSH.
 */

import cockpit from 'cockpit';

import {
    DEFAULT_STACKS_DIR, UNKNOWN, CREATED_FILE, acceptedComposeFileNames,
    statusConvert, parseComposePs, parseDockerStats, parseJSONLines, validateStackName, validateEnv, parseCompose,
} from './util';
import type { StackStatus, ServiceInstance, ContainerStats } from './util';
import updaterScript from './docker-updates.py';

const _ = cockpit.gettext;

/** Empty string means the machine Cockpit is connected to */
export type Host = string;

export interface Agent {
    host: Host;
    name: string;
}

export type AutoUpdate = "off" | "daily" | "weekly";

export interface Settings {
    stacksDir: string;
    primaryHostname: string;
    enableConsole: boolean;
    /** Check images for updates when the page is opened */
    checkUpdates: boolean;
    /** Schedule of cockpit-docker-update.timer */
    autoUpdate: AutoUpdate;
    /** Stacks that automatic updates leave alone */
    autoUpdateExclude: string[];
    agents: Agent[];
}

export const SETTINGS_FILE = "/etc/cockpit/docker.json";

export const defaultSettings: Settings = {
    stacksDir: DEFAULT_STACKS_DIR,
    primaryHostname: "",
    enableConsole: false,
    checkUpdates: true,
    autoUpdate: "off",
    autoUpdateExclude: [],
    agents: [],
};

export interface StackInfo {
    name: string;
    host: Host;
    status: StackStatus;
    isManaged: boolean;
    composeFileName: string;
    configFiles: string;
}

export interface StackDetails extends StackInfo {
    composeYAML: string;
    composeENV: string;
}

type TextSpawnOptions = cockpit.SpawnOptions & { binary?: false };

function spawnOptions(host: Host, extra: TextSpawnOptions = {}): TextSpawnOptions {
    const options: TextSpawnOptions = { superuser: "try", err: "message", ...extra };
    if (host)
        options.host = host;
    return options;
}

export function errorMessage(ex: unknown): string {
    if (ex && typeof ex === "object") {
        const e = ex as { message?: string, problem?: string };
        if (e.message)
            return e.message;
        if (e.problem)
            return e.problem;
    }
    return String(ex);
}

export function run(host: Host, args: string[], extra: TextSpawnOptions = {}): Promise<string> {
    return cockpit.spawn(args, spawnOptions(host, extra)) as unknown as Promise<string>;
}

export function script(host: Host, code: string, args: string[], extra: TextSpawnOptions = {}): Promise<string> {
    return cockpit.script(code, args, spawnOptions(host, extra)) as unknown as Promise<string>;
}

/** Read a file, returning null when it does not exist */
export async function readFile(host: Host, path: string): Promise<string | null> {
    const out = await script(host, 'if [ -f "$1" ]; then printf X; cat "$1"; fi', [path]);
    return out.startsWith("X") ? out.substring(1) : null;
}

export async function writeFile(host: Host, path: string, content: string): Promise<void> {
    const proc = cockpit.spawn(["sh", "-c", 'cat > "$1"', "--", path], spawnOptions(host));
    proc.input(content);
    await proc;
}

export function stackPath(settings: Settings, name: string): string {
    return settings.stacksDir.replace(/\/+$/, "") + "/" + name;
}

/* Settings */

export async function loadSettings(host: Host): Promise<Settings> {
    let content: string | null = null;
    try {
        content = await readFile(host, SETTINGS_FILE);
    } catch (ex) {
        console.warn("Could not read settings:", errorMessage(ex));
    }
    if (!content)
        return { ...defaultSettings, agents: [] };
    try {
        const parsed = JSON.parse(content);
        return {
            ...defaultSettings,
            ...parsed,
            agents: Array.isArray(parsed.agents) ? parsed.agents.filter((a: Agent) => a && typeof a.host === "string") : [],
            autoUpdate: ["daily", "weekly"].includes(parsed.autoUpdate) ? parsed.autoUpdate : "off",
            autoUpdateExclude: Array.isArray(parsed.autoUpdateExclude) ? parsed.autoUpdateExclude.map(String) : [],
        };
    } catch (ex) {
        console.warn("Invalid settings file:", errorMessage(ex));
        return { ...defaultSettings, agents: [] };
    }
}

export async function saveSettings(host: Host, settings: Settings): Promise<void> {
    await run(host, ["mkdir", "-p", SETTINGS_FILE.substring(0, SETTINGS_FILE.lastIndexOf("/"))]);
    await writeFile(host, SETTINGS_FILE, JSON.stringify(settings, null, 4) + "\n");
}

export async function readGlobalEnv(host: Host, settings: Settings): Promise<string> {
    return (await readFile(host, settings.stacksDir.replace(/\/+$/, "") + "/global.env")) ?? "";
}

export async function writeGlobalEnv(host: Host, settings: Settings, content: string): Promise<void> {
    const path = settings.stacksDir.replace(/\/+$/, "") + "/global.env";
    if (content.trim() === "") {
        await run(host, ["rm", "-f", path]);
    } else {
        await run(host, ["mkdir", "-p", settings.stacksDir]);
        await writeFile(host, path, content);
    }
}

/* Docker */

/** Checks that docker and the compose plugin are usable; resolves to the compose version */
export async function checkDocker(host: Host): Promise<string> {
    const out = await run(host, ["docker", "compose", "version", "--short"]);
    return out.trim();
}

export async function getNetworkList(host: Host): Promise<string[]> {
    const out = await run(host, ["docker", "network", "ls", "--format", "{{.Name}}"]);
    return out.split("\n").filter(n => n !== "")
            .sort((a, b) => a.localeCompare(b));
}

export async function getDockerStats(host: Host): Promise<Record<string, ContainerStats>> {
    const out = await run(host, ["docker", "stats", "--no-stream", "--format", "json"]);
    return parseDockerStats(out);
}

const LIST_STACK_DIRS = `
dir="$1"; shift
[ -d "$dir" ] || exit 0
for d in "$dir"/*/; do
    [ -d "$d" ] || continue
    n=$(basename "$d")
    for f in "$@"; do
        if [ -f "$d$f" ]; then printf '%s\\t%s\\n' "$n" "$f"; break; fi
    done
done
`;

/**
 * List stacks: directories in the stacks directory that contain a compose file,
 * plus compose projects that docker knows about but which live elsewhere.
 */
export async function listStacks(host: Host, settings: Settings): Promise<StackInfo[]> {
    const [dirs, ls] = await Promise.all([
        script(host, LIST_STACK_DIRS, [settings.stacksDir, ...acceptedComposeFileNames]),
        run(host, ["docker", "compose", "ls", "--all", "--format", "json"]),
    ]);

    const stacks = new Map<string, StackInfo>();
    for (const line of dirs.split("\n")) {
        const [name, file] = line.split("\t");
        if (!name || !file)
            continue;
        stacks.set(name, {
            name,
            host,
            status: CREATED_FILE,
            isManaged: true,
            composeFileName: file,
            configFiles: stackPath(settings, name) + "/" + file,
        });
    }

    for (const project of parseJSONLines(ls)) {
        let stack = stacks.get(project.Name);
        if (!stack) {
            // Not managed in the stacks directory, but still show it
            stack = {
                name: project.Name,
                host,
                status: UNKNOWN,
                isManaged: false,
                composeFileName: "",
                configFiles: project.ConfigFiles ?? "",
            };
            stacks.set(project.Name, stack);
        }
        stack.status = statusConvert(project.Status ?? "");
    }

    return [...stacks.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function getStack(host: Host, settings: Settings, name: string, known?: StackInfo): Promise<StackDetails> {
    const dir = stackPath(settings, name);
    const found = await script(host, LIST_STACK_DIRS.replace('for d in "$dir"/*/; do', 'for d in "$dir/$STACK/"; do'),
                               [settings.stacksDir, ...acceptedComposeFileNames], { environ: ["STACK=" + name] });
    const file = found.split("\n")[0]?.split("\t")[1];

    if (!file) {
        return {
            name,
            host,
            status: known?.status ?? UNKNOWN,
            isManaged: false,
            composeFileName: "",
            configFiles: known?.configFiles ?? "",
            composeYAML: "",
            composeENV: "",
        };
    }

    const [composeYAML, composeENV] = await Promise.all([
        readFile(host, dir + "/" + file),
        readFile(host, dir + "/.env"),
    ]);

    return {
        name,
        host,
        status: known?.status ?? CREATED_FILE,
        isManaged: true,
        composeFileName: file,
        configFiles: dir + "/" + file,
        composeYAML: composeYAML ?? "",
        composeENV: composeENV ?? "",
    };
}

export class ValidationError extends Error {}

/** Write compose.yaml and .env of a stack; when isAdd, the stack must not exist yet */
export async function saveStack(host: Host, settings: Settings, name: string, composeYAML: string, composeENV: string,
    isAdd: boolean, composeFileName = "compose.yaml"): Promise<void> {
    const nameError = validateStackName(name);
    if (nameError)
        throw new ValidationError(_(nameError));
    parseCompose(composeYAML); // throws on invalid YAML
    const envError = validateEnv(composeENV);
    if (envError)
        throw new ValidationError(_(envError));

    const dir = stackPath(settings, name);
    const exists = (await script(host, '[ -e "$1" ] && echo yes || true', [dir])).trim() === "yes";
    if (isAdd && exists)
        throw new ValidationError(_("Stack name already exists"));
    if (!isAdd && !exists)
        throw new ValidationError(_("Stack not found"));

    await run(host, ["mkdir", "-p", dir]);
    await writeFile(host, dir + "/" + composeFileName, composeYAML);

    const envPath = dir + "/.env";
    const meaningfulEnv = composeENV.split("\n").some(l => l.trim() !== "" && !l.trim().startsWith("#"));
    if (meaningfulEnv || (await readFile(host, envPath)) !== null)
        await writeFile(host, envPath, composeENV);
}

export async function removeStackDir(host: Host, settings: Settings, name: string): Promise<void> {
    if (validateStackName(name))
        throw new ValidationError(_("Invalid stack name"));
    await run(host, ["rm", "-rf", "--", stackPath(settings, name)]);
}

/*
 * docker compose wrapper: runs in the stack directory and adds
 * --env-file ../global.env (and ./.env) when a global.env exists, like Dockge.
 */
const COMPOSE_WRAPPER = `
dir="$1"; shift
cd "$dir" || exit 1
if [ -f ../global.env ]; then
    if [ -f .env ]; then
        set -- --env-file ../global.env --env-file ./.env "$@"
    else
        set -- --env-file ../global.env "$@"
    fi
fi
exec docker compose "$@"
`;

export function composeArgv(settings: Settings, name: string, args: string[]): string[] {
    return ["/bin/sh", "-c", COMPOSE_WRAPPER, "compose", stackPath(settings, name), ...args];
}

/** Run a compose command and collect its output */
export function compose(host: Host, settings: Settings, name: string, args: string[]): Promise<string> {
    const [cmd, ...rest] = composeArgv(settings, name, args);
    return cockpit.spawn([cmd, ...rest], spawnOptions(host)) as unknown as Promise<string>;
}

export async function getServiceStatus(host: Host, settings: Settings, name: string): Promise<Record<string, ServiceInstance[]>> {
    const out = await compose(host, settings, name, ["ps", "--all", "--format", "json"]);
    return parseComposePs(out);
}

/** Open a pty stream channel for a process, for display in a terminal */
export function openPtyChannel(host: Host, argv: string[], directory?: string): cockpit.Channel<string> {
    const options: cockpit.ChannelOpenOptions & { binary?: false } = {
        payload: "stream",
        spawn: argv,
        pty: true,
        environ: ["TERM=xterm-256color", "COMPOSE_MENU=false"],
        superuser: "try",
        err: "out",
    };
    if (directory)
        options.directory = directory;
    if (host)
        options.host = host;
    return cockpit.channel(options);
}

export function composeChannel(host: Host, settings: Settings, name: string, args: string[]): cockpit.Channel<string> {
    return openPtyChannel(host, composeArgv(settings, name, args));
}

export interface ChannelResult {
    exitStatus: number | null;
    problem: string | null;
}

/** Resolves when the channel closes, with the process exit status */
export function channelDone(channel: cockpit.Channel<string>): Promise<ChannelResult> {
    return new Promise(resolve => {
        channel.addEventListener("close", (_ev, options) => {
            const opts = options as Record<string, unknown>;
            const status = opts["exit-status"];
            resolve({
                exitStatus: typeof status === "number" ? status : null,
                problem: typeof opts.problem === "string" ? opts.problem : null,
            });
        });
    });
}

/* Download and import of stacks, as .tar.gz of the stacks directory layout */

const EXPORT_STACKS = `
dir="$1"; everything="$2"; global="$3"; shift 3
cd "$dir" || exit 1
{
    for n in "$@"; do
        if [ "$everything" = yes ]; then
            printf '%s\\0' "$n"
        else
            for f in ${acceptedComposeFileNames.join(" ")} .env; do
                if [ -f "$n/$f" ]; then printf '%s\\0' "$n/$f"; fi
            done
        fi
    done
    if [ "$global" = yes ] && [ -f global.env ]; then printf '%s\\0' global.env; fi
} | tar czf - --null -T -
`;

function binaryOptions(host: Host): cockpit.SpawnOptions & { binary: true } {
    const options: cockpit.SpawnOptions & { binary: true } = { binary: true, superuser: "try", err: "message" };
    if (host)
        options.host = host;
    return options;
}

/**
 * A .tar.gz of stacks: their compose files and .env, or with everything their
 * directories hold; and global.env when asked.
 */
export async function exportStacks(host: Host, settings: Settings, names: string[], everything: boolean,
    withGlobalEnv: boolean): Promise<Uint8Array> {
    names.forEach(n => {
        if (validateStackName(n))
            throw new ValidationError(cockpit.format(_("Invalid stack name: $0"), n));
    });
    return await cockpit.script(EXPORT_STACKS, [settings.stacksDir, everything ? "yes" : "no", withGlobalEnv ? "yes" : "no", ...names],
                                binaryOptions(host)) as unknown as Uint8Array;
}

export interface ImportArchive {
    host: Host;
    /** Temporary directory on the host with the unpacked archive in "content" */
    dir: string;
    stacks: string[];
    hasGlobalEnv: boolean;
}

/** Copy an archive to the host and unpack it into a temporary directory there */
export async function openImportArchive(host: Host, data: Uint8Array): Promise<ImportArchive> {
    const dir = (await run(host, ["mktemp", "-d", "/tmp/cockpit-dockerstacks-import.XXXXXX"])).trim();
    try {
        const proc = cockpit.spawn(["sh", "-c", 'cat > "$1"', "--", dir + "/archive"], binaryOptions(host));
        proc.input(data);
        await proc;
        await script(host, 'cd "$1" && mkdir content && tar xzf archive -C content --no-same-owner && rm archive', [dir]);
        const found = await script(host, LIST_STACK_DIRS, [dir + "/content", ...acceptedComposeFileNames]);
        const stacks = found.split("\n").map(l => l.split("\t")[0])
                .filter((n): n is string => !!n && validateStackName(n) === null);
        const hasGlobalEnv = (await script(host, '[ -f "$1/content/global.env" ] && echo yes || true', [dir])).trim() === "yes";
        return { host, dir, stacks, hasGlobalEnv };
    } catch (ex) {
        await closeImportArchive({ host, dir, stacks: [], hasGlobalEnv: false });
        throw ex;
    }
}

const IMPORT_STACKS = `
src="$1/content"; dir="$2"; global="$3"; shift 3
mkdir -p "$dir" || exit 1
for n in "$@"; do
    mkdir -p "$dir/$n" && cp -a "$src/$n/." "$dir/$n/" || exit 1
done
if [ "$global" = yes ]; then cp "$src/global.env" "$dir/global.env" || exit 1; fi
`;

/** Copy stacks from an unpacked archive into the stacks directory; existing files are overwritten */
export async function importStacks(archive: ImportArchive, settings: Settings, names: string[], withGlobalEnv: boolean): Promise<void> {
    names.forEach(n => {
        if (!archive.stacks.includes(n))
            throw new ValidationError(cockpit.format(_("Invalid stack name: $0"), n));
    });
    await script(archive.host, IMPORT_STACKS, [archive.dir, settings.stacksDir, withGlobalEnv ? "yes" : "no", ...names]);
}

export async function closeImportArchive(archive: ImportArchive): Promise<void> {
    if (archive.dir.startsWith("/tmp/cockpit-dockerstacks-import."))
        await run(archive.host, ["rm", "-rf", archive.dir]);
}

/* Image updates, see docker-updates.py */

export type UpdateStatus = "update-available" | "up-to-date" | "local" | "pinned" | "error";

export interface ServiceUpdate {
    stack: string;
    service: string;
    image: string;
    status: UpdateStatus;
    error: string | null;
}

/** Check the images of all stacks, or of one, against their registries */
export async function checkUpdates(host: Host, stack?: string): Promise<ServiceUpdate[]> {
    const out = await run(host, ["python3", "-c", updaterScript, "check", ...stack ? ["--stack", stack] : []]);
    return JSON.parse(out);
}

export const UPDATER_PATH = "/usr/local/libexec/cockpit-dockerstacks-update";
export const UPDATE_UNIT = "cockpit-dockerstacks-update";

const UPDATE_SERVICE = `[Unit]
Description=Update Docker compose stacks that have newer images
Documentation=https://github.com/avandeputte/cockpit-dockerstacks
Wants=network-online.target
After=network-online.target docker.service

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 ${UPDATER_PATH} auto
`;

function updateTimer(schedule: AutoUpdate): string {
    return `[Unit]
Description=Update Docker compose stacks ${schedule}

[Timer]
OnCalendar=${schedule}
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
`;
}

/** Install or remove the systemd timer for automatic updates */
export async function configureAutoUpdate(host: Host, schedule: AutoUpdate): Promise<void> {
    const unitDir = "/etc/systemd/system/";
    if (schedule === "off") {
        await script(host, `
            systemctl disable --now "$1.timer" 2>/dev/null || true
            rm -f "$2$1.timer" "$2$1.service" "$3"
            systemctl daemon-reload
        `, [UPDATE_UNIT, unitDir, UPDATER_PATH]);
        return;
    }
    await run(host, ["mkdir", "-p", UPDATER_PATH.substring(0, UPDATER_PATH.lastIndexOf("/"))]);
    await writeFile(host, UPDATER_PATH, updaterScript);
    await run(host, ["chmod", "755", UPDATER_PATH]);
    await writeFile(host, unitDir + UPDATE_UNIT + ".service", UPDATE_SERVICE);
    await writeFile(host, unitDir + UPDATE_UNIT + ".timer", updateTimer(schedule));
    await script(host, 'systemctl daemon-reload && systemctl enable "$1.timer" && systemctl restart "$1.timer"', [UPDATE_UNIT]);
}

/** Keep the installed update script in sync with this version of the page */
export async function syncUpdater(host: Host): Promise<void> {
    const installed = await readFile(host, UPDATER_PATH);
    if (installed !== null && installed !== updaterScript)
        await writeFile(host, UPDATER_PATH, updaterScript);
}

/** Stack-level actions, matching Dockge's buttons */
export type StackAction = "deploy" | "start" | "stop" | "restart" | "down" | "update-pull" | "update-up" | "delete";

export function actionArgs(action: StackAction): string[] {
    switch (action) {
    case "deploy":
    case "start":
    case "update-up":
        return ["up", "-d", "--remove-orphans"];
    case "stop":
        return ["stop"];
    case "restart":
        return ["restart"];
    case "down":
        return ["down"];
    case "update-pull":
        return ["pull"];
    case "delete":
        return ["down", "--remove-orphans"];
    }
}

export type ServiceAction = "start" | "stop" | "restart";

export function serviceActionArgs(action: ServiceAction, service: string): string[] {
    switch (action) {
    case "start":
        return ["up", "-d", service];
    case "stop":
        return ["stop", service];
    case "restart":
        return ["restart", service];
    }
}

/** The interactive shell for the stack directory console */
export function consoleArgv(): string[] {
    return ["/bin/sh", "-c", 'if command -v bash >/dev/null; then exec bash -l; else exec sh -l; fi'];
}
