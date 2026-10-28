/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Main page: stack counts, stack list, "docker run" converter and agents.
 */

import React, { useState } from 'react';
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardHeader, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Content } from "@patternfly/react-core/dist/esm/components/Content/index.js";
import { DescriptionList, DescriptionListDescription, DescriptionListGroup, DescriptionListTerm } from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";
import { Form, FormGroup } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { Dropdown, DropdownItem, DropdownList } from "@patternfly/react-core/dist/esm/components/Dropdown/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { MenuToggle } from "@patternfly/react-core/dist/esm/components/MenuToggle/index.js";
import { PageSection } from "@patternfly/react-core/dist/esm/components/Page/index.js";
import { SearchInput } from "@patternfly/react-core/dist/esm/components/SearchInput/index.js";
import { TextArea } from "@patternfly/react-core/dist/esm/components/TextArea/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";
import { ToggleGroup, ToggleGroupItem } from "@patternfly/react-core/dist/esm/components/ToggleGroup/index.js";
import { Toolbar, ToolbarContent, ToolbarItem } from "@patternfly/react-core/dist/esm/components/Toolbar/index.js";
import { Flex, FlexItem } from "@patternfly/react-core/dist/esm/layouts/Flex/index.js";
import { Gallery } from "@patternfly/react-core/dist/esm/layouts/Gallery/index.js";
import { Stack } from "@patternfly/react-core/dist/esm/layouts/Stack/index.js";
import { PlusIcon, CogIcon, TerminalIcon, SyncAltIcon, EllipsisVIcon } from '@patternfly/react-icons';

import cockpit from 'cockpit';
import { ListingTable } from "cockpit-components-table.jsx";
import { EmptyStatePanel } from "cockpit-components-empty-state.jsx";
import { useDialogs } from "dialogs.jsx";

import { Model, goto, pendingTemplate } from './model';
import type { HostState } from './model';
import { errorMessage } from './docker';
import { StackStatusLabel, UpdateLabel } from './StatusLabel';
import { SettingsDialog } from './SettingsDialog';
import { DownloadDialog, ImportDialog } from './Transfer';
import { dockerRunToCompose, matchesStatusFilter, statusClass } from './util';
import type { StatusFilter } from './util';

const _ = cockpit.gettext;

const Summary = ({ model }: { model: Model }) => {
    const stacks = model.allStacks();
    const count = (cls: string) => stacks.filter(s => statusClass(s.status) === cls).length;
    const checked = [...model.updates.values()].some(u => u.checkedAt !== null);
    const updates = stacks.filter(s => model.hasUpdate(s.host, s.name)).length;
    return (
        <Card id="stack-summary" isCompact>
            <CardBody>
                <Flex justifyContent={{ default: "justifyContentSpaceAround" }}>
                    {([["active", _("Active")], ["exited", _("Exited")], ["inactive", _("Inactive")]] as const).map(([cls, label]) => (
                        <FlexItem key={cls} className={"summary-" + cls}>
                            <div className="summary-label">{label}</div>
                            <div className={"summary-number summary-number-" + cls}>{count(cls)}</div>
                        </FlexItem>
                    ))}
                    {checked &&
                        <FlexItem className="summary-updates">
                            <div className="summary-label">{_("Updates")}</div>
                            <div className="summary-number summary-number-updates">{updates}</div>
                        </FlexItem>}
                </Flex>
            </CardBody>
        </Card>
    );
};

const StackList = ({ model }: { model: Model }) => {
    const Dialogs = useDialogs();
    const [kebabOpen, setKebabOpen] = useState(false);
    const [search, setSearch] = useState("");
    const [filter, setFilter] = useState<StatusFilter>("all");
    const multiHost = model.hostList.length > 1;

    const hostStates = [...model.hosts.values()];
    const loading = hostStates.every(h => h.stacks === null && h.status === "connecting");
    const term = search.trim().toLowerCase();

    const stacks = model.allStacks().filter(s =>
        matchesStatusFilter(s.status, filter) &&
        (term === "" || s.name.toLowerCase().includes(term) || model.hostDisplayName(s.host).toLowerCase()
                .includes(term))
    );

    // Active stacks first, then by name, like Dockge
    const order = { active: 0, exited: 1, inactive: 2, unknown: 3 };
    stacks.sort((a, b) => order[statusClass(a.status)] - order[statusClass(b.status)] || a.name.localeCompare(b.name));

    const columns = [
        { title: _("Name"), header: true },
        _("Status"),
        ...multiHost ? [_("Host")] : [],
        _("Compose file"),
    ];

    const rows = stacks.map(stack => ({
        props: { key: stack.host + "/" + stack.name, "data-stack": stack.name, "data-host": stack.host },
        columns: [
            {
                title: (
                    <Flex spaceItems={{ default: "spaceItemsSm" }} alignItems={{ default: "alignItemsCenter" }}>
                        <Button variant="link" isInline className="stack-name"
                                onClick={() => goto(["stack", stack.name], stack.host)}>
                            {stack.name}
                        </Button>
                        {!stack.isManaged && <Label isCompact variant="outline">{_("Not managed")}</Label>}
                        <UpdateLabel updates={model.stackUpdates(stack.host, stack.name).filter(u => u.status === "update-available")} />
                    </Flex>
                ),
            },
            { title: <StackStatusLabel status={stack.status} /> },
            ...multiHost ? [{ title: model.hostDisplayName(stack.host) }] : [],
            { title: <span className="ct-monospace compose-file">{stack.configFiles}</span> },
        ],
    }));

    const errors = hostStates.filter(h => h.status === "offline");
    const updateErrors = model.hostList.filter(h => model.hosts.get(h)?.status === "online" && model.updates.get(h)?.error);
    const lastChecked = Math.max(0, ...[...model.updates.values()].map(u => u.checkedAt ?? 0));

    return (
        <Card id="stack-list" className="ct-card">
            <CardHeader actions={{
                actions: (
                    <Flex spaceItems={{ default: "spaceItemsSm" }} alignItems={{ default: "alignItemsCenter" }}>
                        {lastChecked > 0 &&
                            <span className="pf-v6-u-text-color-subtle pf-v6-u-font-size-sm" id="updates-checked">
                                {cockpit.format(_("Checked $0"), new Date(lastChecked).toLocaleTimeString())}
                            </span>}
                        <Button variant="secondary" id="check-updates" icon={<SyncAltIcon />}
                                isLoading={model.checkingUpdates} isDisabled={model.checkingUpdates}
                                onClick={() => model.checkAllUpdates()}>
                            {_("Check for updates")}
                        </Button>
                        <Button variant="primary" id="create-stack" icon={<PlusIcon />}
                                onClick={() => goto(["new"], "")}>
                            {_("Create stack")}
                        </Button>
                        <Dropdown isOpen={kebabOpen} onOpenChange={setKebabOpen} popperProps={{ position: "right" }}
                                  toggle={ref => (
                                      <MenuToggle ref={ref} variant="plain" id="stacks-kebab" aria-label={_("More actions")}
                                                  onClick={() => setKebabOpen(!kebabOpen)} icon={<EllipsisVIcon />} />
                                  )}>
                            <DropdownList>
                                <DropdownItem id="download-all" onClick={() => { setKebabOpen(false); Dialogs.show(<DownloadDialog model={model} host="" />) }}>
                                    {_("Download all stacks")}
                                </DropdownItem>
                                <DropdownItem id="import-stacks" onClick={() => { setKebabOpen(false); Dialogs.show(<ImportDialog model={model} />) }}>
                                    {_("Import stacks")}
                                </DropdownItem>
                            </DropdownList>
                        </Dropdown>
                    </Flex>
                ),
            }}>
                <CardTitle component="h2">{_("Stacks")}</CardTitle>
            </CardHeader>
            <CardBody>
                <Stack hasGutter>
                    {errors.map(h => (
                        <Alert key={h.host} isInline variant="danger" className="host-error"
                               title={cockpit.format(_("Cannot list stacks on $0"), model.hostDisplayName(h.host))}>
                            {h.error}
                        </Alert>
                    ))}
                    {updateErrors.map(h => (
                        <Alert key={h} isInline variant="warning" className="update-error"
                               title={cockpit.format(_("Cannot check for updates on $0"), model.hostDisplayName(h))}>
                            {model.updates.get(h)?.error}
                        </Alert>
                    ))}
                    <Toolbar>
                        <ToolbarContent>
                            <ToolbarItem>
                                <SearchInput id="stack-search" placeholder={_("Search stacks")} value={search}
                                             onChange={(_ev, v) => setSearch(v)} onClear={() => setSearch("")} />
                            </ToolbarItem>
                            <ToolbarItem>
                                <ToggleGroup aria-label={_("Filter by status")} id="stack-filter">
                                    {([["all", _("All")], ["active", _("Active")], ["exited", _("Exited")], ["inactive", _("Inactive")]] as const).map(([value, label]) => (
                                        <ToggleGroupItem key={value} text={label} buttonId={"filter-" + value}
                                                         isSelected={filter === value}
                                                         onChange={() => setFilter(value)} />
                                    ))}
                                </ToggleGroup>
                            </ToolbarItem>
                        </ToolbarContent>
                    </Toolbar>
                    {loading
                        ? <EmptyStatePanel loading title={_("Loading stacks")} />
                        : <ListingTable aria-label={_("Stacks")}
                                        variant="compact"
                                        columns={columns}
                                        rows={rows}
                                        emptyCaption={term || filter !== "all" ? _("No stacks match the filter") : _("No stacks yet")}
                                        emptyCaptionDetail={term || filter !== "all"
                                            ? undefined
                                            : <Button variant="link" isInline onClick={() => goto(["new"], "")}>{_("Compose your first stack")}</Button>} />}
                </Stack>
            </CardBody>
        </Card>
    );
};

const DockerRunCard = () => {
    const [command, setCommand] = useState("");
    const [error, setError] = useState<string | null>(null);

    const convert = () => {
        try {
            pendingTemplate.composeYAML = dockerRunToCompose(command);
            setError(null);
            goto(["new"], "");
        } catch (ex) {
            setError(errorMessage(ex));
        }
    };

    return (
        <Card id="docker-run" className="ct-card">
            <CardHeader><CardTitle component="h2">{_("Docker run")}</CardTitle></CardHeader>
            <CardBody>
                <Form onSubmit={ev => { ev.preventDefault(); convert() }}>
                    <FormGroup fieldId="docker-run-command" label={_("Convert a docker run command into a compose stack")}>
                        <TextArea id="docker-run-command" className="ct-monospace" value={command}
                                  onChange={(_ev, v) => setCommand(v)} placeholder="docker run ..." rows={4} resizeOrientation="vertical" />
                    </FormGroup>
                    {error && <Alert isInline variant="danger" title={error} />}
                    <div>
                        <Button variant="secondary" id="convert-docker-run" onClick={convert}>{_("Convert to compose")}</Button>
                    </div>
                </Form>
            </CardBody>
        </Card>
    );
};

const AgentStatusLabel = ({ state }: { state: HostState | undefined }) => {
    if (!state || state.status === "connecting")
        return <Label isCompact color="grey">{_("Connecting")}</Label>;
    if (state.status === "online")
        return <Label isCompact color="green">{_("Online")}</Label>;
    return <Label isCompact color="red">{_("Offline")}</Label>;
};

const AgentsCard = ({ model }: { model: Model }) => {
    const [adding, setAdding] = useState(false);
    const [host, setHost] = useState("");
    const [name, setName] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [editing, setEditing] = useState<string | null>(null);
    const [editName, setEditName] = useState("");

    const add = () => {
        setBusy(true);
        setError(null);
        model.addAgent({ host, name })
                .then(() => {
                    setAdding(false);
                    setHost("");
                    setName("");
                })
                .catch(ex => setError(errorMessage(ex)))
                .finally(() => setBusy(false));
    };

    const act = (promise: Promise<void>) => {
        setError(null);
        promise.catch(ex => setError(errorMessage(ex)));
    };

    return (
        <Card id="agents" className="ct-card">
            <CardHeader actions={{
                actions: !adding && (
                    <Button variant="secondary" id="add-agent" onClick={() => setAdding(true)}>{_("Add host")}</Button>
                ),
            }}>
                <CardTitle component="h2">{_("Hosts")}</CardTitle>
            </CardHeader>
            <CardBody>
                <Stack hasGutter>
                    <Content component="p" className="pf-v6-u-text-color-subtle">
                        {_("Stacks on other machines are managed through Cockpit's SSH connection to them. Docker and the compose plugin must be installed there.")}
                    </Content>
                    <DescriptionList isHorizontal isCompact>
                        {model.hostList.map(h => {
                            const agent = model.agents.find(a => a.host === h);
                            const state = model.hosts.get(h);
                            return (
                                <DescriptionListGroup key={h} data-host={h} className="agent">
                                    <DescriptionListTerm>
                                        <AgentStatusLabel state={state} />
                                    </DescriptionListTerm>
                                    <DescriptionListDescription>
                                        {editing === h && agent
                                            ? (
                                                <Flex spaceItems={{ default: "spaceItemsSm" }}>
                                                    <TextInput aria-label={_("Display name")} value={editName}
                                                               onChange={(_ev, v) => setEditName(v)} />
                                                    <Button variant="primary" size="sm" onClick={() => { setEditing(null); act(model.renameAgent(h, editName)) }}>{_("Save")}</Button>
                                                    <Button variant="link" size="sm" onClick={() => setEditing(null)}>{_("Cancel")}</Button>
                                                </Flex>
                                            )
                                            : (
                                                <Flex spaceItems={{ default: "spaceItemsSm" }} alignItems={{ default: "alignItemsCenter" }}>
                                                    <span className="agent-name">{model.hostDisplayName(h)}</span>
                                                    {agent?.name && <span className="pf-v6-u-text-color-subtle">({h})</span>}
                                                    {agent && <>
                                                        <Button variant="link" isInline size="sm" onClick={() => { setEditName(agent.name); setEditing(h) }}>{_("Rename")}</Button>
                                                        <Button variant="link" isInline isDanger size="sm" className="remove-agent"
                                                                onClick={() => act(model.removeAgent(h))}>{_("Remove")}</Button>
                                                    </>}
                                                </Flex>
                                            )}
                                        {state?.status === "offline" && <div className="pf-v6-u-text-color-subtle agent-error">{state.error}</div>}
                                    </DescriptionListDescription>
                                </DescriptionListGroup>
                            );
                        })}
                    </DescriptionList>
                    {adding &&
                        <Form isHorizontal onSubmit={ev => { ev.preventDefault(); add() }} id="add-agent-form">
                            <FormGroup label={_("Host")} fieldId="agent-host" isRequired>
                                <TextInput id="agent-host" value={host} placeholder="user@server" onChange={(_ev, v) => setHost(v)} />
                            </FormGroup>
                            <FormGroup label={_("Display name")} fieldId="agent-name">
                                <TextInput id="agent-name" value={name} onChange={(_ev, v) => setName(v)} />
                            </FormGroup>
                            <Flex>
                                <Button variant="primary" type="submit" isLoading={busy} isDisabled={busy || host.trim() === ""}>{_("Add")}</Button>
                                <Button variant="link" onClick={() => { setAdding(false); setError(null) }}>{_("Cancel")}</Button>
                            </Flex>
                        </Form>}
                    {error && <Alert isInline variant="danger" title={_("Host operation failed")}>{error}</Alert>}
                </Stack>
            </CardBody>
        </Card>
    );
};

export const Overview = ({ model }: { model: Model }) => {
    const Dialogs = useDialogs();
    const local = model.localSettings;

    return (
        <>
            <PageSection hasBodyWrapper={false} className="overview-header">
                <Flex justifyContent={{ default: "justifyContentSpaceBetween" }} alignItems={{ default: "alignItemsCenter" }}>
                    <Content component="h1">{_("Docker stacks")}</Content>
                    <Flex spaceItems={{ default: "spaceItemsSm" }}>
                        {local?.enableConsole &&
                            <Button variant="secondary" id="open-console" icon={<TerminalIcon />}
                                    onClick={() => goto(["console"], "")}>
                                {_("Console")}
                            </Button>}
                        <Button variant="secondary" id="open-settings" icon={<CogIcon />}
                                onClick={() => Dialogs.show(<SettingsDialog model={model} />)}>
                            {_("Settings")}
                        </Button>
                    </Flex>
                </Flex>
            </PageSection>
            <PageSection hasBodyWrapper={false}>
                <Stack hasGutter>
                    {model.localSettingsError &&
                        <Alert isInline variant="warning" title={_("Could not read settings, using defaults")}>{model.localSettingsError}</Alert>}
                    <Summary model={model} />
                    <StackList model={model} />
                    <Gallery hasGutter minWidths={{ default: "100%", lg: "calc(50% - var(--pf-t--global--spacer--md))" }}>
                        <DockerRunCard />
                        <AgentsCard model={model} />
                    </Gallery>
                </Stack>
            </PageSection>
        </>
    );
};
