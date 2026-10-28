/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * A single stack: actions, services, logs and the compose.yaml/.env editors.
 * Also used to compose a new stack. Port of Dockge's Compose.vue.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AlertActionCloseButton } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Breadcrumb, BreadcrumbItem } from "@patternfly/react-core/dist/esm/components/Breadcrumb/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardHeader, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Content } from "@patternfly/react-core/dist/esm/components/Content/index.js";
import { Dropdown, DropdownItem, DropdownList } from "@patternfly/react-core/dist/esm/components/Dropdown/index.js";
import { Form, FormGroup, FormHelperText } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { FormSelect, FormSelectOption } from "@patternfly/react-core/dist/esm/components/FormSelect/index.js";
import { HelperText, HelperTextItem } from "@patternfly/react-core/dist/esm/components/HelperText/index.js";
import { InputGroup, InputGroupItem } from "@patternfly/react-core/dist/esm/components/InputGroup/index.js";
import { Label, LabelGroup } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { MenuToggle } from "@patternfly/react-core/dist/esm/components/MenuToggle/index.js";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@patternfly/react-core/dist/esm/components/Modal/index.js";
import { PageBreadcrumb, PageSection } from "@patternfly/react-core/dist/esm/components/Page/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";
import { Flex } from "@patternfly/react-core/dist/esm/layouts/Flex/index.js";
import { Grid, GridItem } from "@patternfly/react-core/dist/esm/layouts/Grid/index.js";
import { Stack } from "@patternfly/react-core/dist/esm/layouts/Stack/index.js";
import { EllipsisVIcon, ExternalLinkAltIcon } from '@patternfly/react-icons';

import cockpit from 'cockpit';
import { EmptyStatePanel } from "cockpit-components-empty-state.jsx";

import * as docker from './docker';
import type { Host, StackAction, ServiceAction, StackDetails, Settings } from './docker';
import { CodeEditor } from './CodeEditor';
import { NetworksEditor } from './NetworksEditor';
import { ListInput } from './ListInput';
import { ServiceCard } from './ServiceCard';
import { StackStatusLabel } from './StatusLabel';
import { OutputTerminal, ProgressTerminal, ProgressTerminalState, canUseTerminal } from './Terminals';
import { Model, POLL_INTERVAL, goto, pendingTemplate } from './model';
import {
    RUNNING, UNKNOWN, composeToYAML, defaultComposeTemplate, defaultEnvTemplate, defaultStackName,
    envsubstYAML, parseCompose, parseDotenv, stackUrls, validateStackName,
} from './util';
import type { ContainerStats, LooseObject, ServiceInstance } from './util';
import type { Document } from 'yaml';

const _ = cockpit.gettext;

interface ParsedState {
    config: LooseObject;
    envConfig: LooseObject;
    error: string | null;
}

function parseAll(yamlText: string, envText: string, previous: LooseObject): ParsedState & { doc: Document | null } {
    try {
        const { config, doc } = parseCompose(yamlText);
        let envConfig = config;
        try {
            envConfig = parseCompose(envsubstYAML(yamlText, parseDotenv(envText))).config;
        } catch {
            // keep unsubstituted config
        }
        return { config, envConfig, error: null, doc };
    } catch (ex) {
        return { config: previous, envConfig: previous, error: docker.errorMessage(ex), doc: null };
    }
}

const actionFailedText: Record<StackAction, string> = {
    deploy: _("Failed to deploy, please check the terminal output for more information."),
    start: _("Failed to start, please check the terminal output for more information."),
    stop: _("Failed to stop, please check the terminal output for more information."),
    restart: _("Failed to restart, please check the terminal output for more information."),
    down: _("Failed to stop and remove, please check the terminal output for more information."),
    "update-pull": _("Failed to pull, please check the terminal output for more information."),
    "update-up": _("Failed to restart, please check the terminal output for more information."),
    delete: _("Failed to delete, please check the terminal output for more information."),
};

const actionDoneText: Record<string, string> = {
    deploy: _("Deployed"),
    start: _("Started"),
    stop: _("Stopped"),
    restart: _("Restarted"),
    down: _("Stopped and removed"),
    update: _("Updated"),
    save: _("Saved"),
};

const DeleteModal = ({ name, onConfirm, onClose }: { name: string, onConfirm: () => void, onClose: () => void }) => (
    <Modal id="delete-stack-dialog" position="top" variant="small" isOpen onClose={onClose}>
        <ModalHeader title={cockpit.format(_("Delete stack $0?"), name)} titleIconVariant="warning" />
        <ModalBody>
            {_("Are you sure you want to delete this stack? Its containers are stopped and removed, and its directory including compose.yaml and .env is deleted.")}
        </ModalBody>
        <ModalFooter>
            <Button variant="danger" id="delete-stack-confirm" onClick={onConfirm}>{_("Delete")}</Button>
            <Button variant="link" onClick={onClose}>{_("Cancel")}</Button>
        </ModalFooter>
    </Modal>
);

export const StackPage = ({ model, host: initialHost, name: routeName, isAdd }: {
    model: Model,
    host: Host,
    name: string,
    isAdd: boolean,
}) => {
    const [host, setHost] = useState<Host>(initialHost);
    const [stack, setStack] = useState<StackDetails | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [name, setName] = useState(routeName);
    const [composeYAML, setComposeYAML] = useState("");
    const [composeENV, setComposeENV] = useState("");
    const [parsed, setParsed] = useState<ParsedState>({ config: { services: {} }, envConfig: { services: {} }, error: null });
    const docRef = useRef<Document | null>(null);
    const [isEditMode, setEditMode] = useState(isAdd);
    const [processing, setProcessing] = useState(!isAdd);
    const [actionError, setActionError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [serviceStatus, setServiceStatus] = useState<Record<string, ServiceInstance[]>>({});
    const [stats, setStats] = useState<Record<string, ContainerStats>>({});
    const [newServiceName, setNewServiceName] = useState("");
    const [showDelete, setShowDelete] = useState(false);
    const [kebabOpen, setKebabOpen] = useState(false);
    const [logsKey, setLogsKey] = useState(0);
    const [showProgress, setShowProgress] = useState(false);
    const progress = useMemo(() => new ProgressTerminalState(), []);
    const terminalsSupported = useMemo(canUseTerminal, []);

    useEffect(() => () => progress.close(), [progress]);

    const settings: Settings | null = model.settingsFor(host);
    const globalStack = model.findStack(host, name);
    const status = globalStack?.status ?? (isAdd ? UNKNOWN : stack?.status ?? UNKNOWN);
    const active = status === RUNNING;
    const hostname = model.hostnameFor(host);

    const setYAML = useCallback((text: string, env: string) => {
        setComposeYAML(text);
        setParsed(prev => {
            const p = parseAll(text, env, prev.config);
            if (p.doc)
                docRef.current = p.doc;
            return { config: p.config, envConfig: p.envConfig, error: p.error };
        });
    }, []);

    const load = useCallback(() => {
        if (isAdd || !settings)
            return;
        setProcessing(true);
        docker.getStack(host, settings, routeName, model.findStack(host, routeName))
                .then(s => {
                    setStack(s);
                    setComposeENV(s.composeENV);
                    setYAML(s.composeYAML, s.composeENV);
                    setLoadError(null);
                })
                .catch(ex => setLoadError(docker.errorMessage(ex)))
                .finally(() => setProcessing(false));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isAdd, host, routeName, settings?.stacksDir, setYAML]);

    // Initial content
    useEffect(() => {
        if (isAdd) {
            const template = pendingTemplate.composeYAML ?? defaultComposeTemplate;
            pendingTemplate.composeYAML = null;
            setComposeENV(defaultEnvTemplate);
            setYAML(template, defaultEnvTemplate);
            setStack({
                name: "",
                host,
                status: UNKNOWN,
                isManaged: true,
                composeFileName: "compose.yaml",
                configFiles: "",
                composeYAML: template,
                composeENV: defaultEnvTemplate,
            });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isAdd]);

    useEffect(load, [load]);

    // Poll service status and docker stats, like Dockge does every 5 seconds
    const refreshStatus = useCallback(() => {
        if (isAdd || !settings || !stack?.isManaged)
            return;
        docker.getServiceStatus(host, settings, routeName)
                .then(setServiceStatus)
                .catch(ex => console.warn("compose ps failed:", docker.errorMessage(ex)));
        docker.getDockerStats(host)
                .then(setStats)
                .catch(ex => console.warn("docker stats failed:", docker.errorMessage(ex)));
    }, [isAdd, host, routeName, settings, stack?.isManaged]);

    useEffect(() => {
        refreshStatus();
        const timer = window.setInterval(() => {
            if (document.visibilityState === "visible")
                refreshStatus();
        }, POLL_INTERVAL);
        return () => window.clearInterval(timer);
    }, [refreshStatus]);

    /* Editing */

    const onYAMLChange = (text: string) => setYAML(text, composeENV);
    const onENVChange = (text: string) => {
        setComposeENV(text);
        setYAML(composeYAML, text);
    };

    const updateConfig = (mutate: (config: LooseObject) => void) => {
        const config = structuredClone(parsed.config);
        mutate(config);
        const { yaml, doc } = composeToYAML(config, docRef.current);
        docRef.current = doc;
        setYAML(yaml, composeENV);
    };

    const addService = () => {
        const serviceName = newServiceName.trim();
        if (!serviceName) {
            setActionError(_("Container name cannot be empty"));
            return;
        }
        if (parsed.config.services?.[serviceName]) {
            setActionError(_("Container name already exists"));
            return;
        }
        updateConfig(c => {
            c.services = { ...c.services, [serviceName]: { restart: "unless-stopped" } };
        });
        setNewServiceName("");
        setActionError(null);
    };

    /* Actions */

    const runCompose = async (action: StackAction | null, args: string[], targetName: string): Promise<boolean> => {
        if (!settings)
            return false;
        const channel = docker.composeChannel(host, settings, targetName, args);
        progress.run(channel);
        setShowProgress(true);
        const result = await docker.channelDone(channel);
        if (result.exitStatus !== 0) {
            const msg = action ? actionFailedText[action] : _("The command failed, please check the terminal output for more information.");
            throw new Error(result.problem ? `${msg} (${result.problem})` : msg);
        }
        return true;
    };

    const finish = (doneKey: string) => {
        setNotice(actionDoneText[doneKey] ?? null);
        setActionError(null);
        model.refresh(host);
        refreshStatus();
        setLogsKey(k => k + 1);
    };

    const perform = (fn: () => Promise<void>) => {
        setProcessing(true);
        setActionError(null);
        setNotice(null);
        fn()
                .catch(ex => setActionError(docker.errorMessage(ex)))
                .finally(() => setProcessing(false));
    };

    const stackAction = (action: StackAction) => perform(async () => {
        await runCompose(action, docker.actionArgs(action), name);
        finish(action);
    });

    const updateStack = () => perform(async () => {
        await runCompose("update-pull", docker.actionArgs("update-pull"), name);
        // Only bring the stack up again if it was running
        await model.refresh(host);
        if (model.findStack(host, name)?.status === RUNNING)
            await runCompose("update-up", docker.actionArgs("update-up"), name);
        finish("update");
    });

    const serviceAction = (action: ServiceAction, service: string) => perform(async () => {
        await runCompose(null, docker.serviceActionArgs(action, service), name);
        finish(action);
    });

    const targetName = () => {
        let n = name.trim().toLowerCase();
        if (!n && isAdd)
            n = defaultStackName(parsed.config);
        return n;
    };

    const checkBeforeSave = (): string => {
        if (parsed.error)
            throw new Error(parsed.error);
        const services = parsed.config.services;
        if (!services || Object.keys(services).length === 0)
            throw new Error(_("No services found in compose.yaml"));
        const n = targetName();
        const err = validateStackName(n);
        if (err)
            throw new Error(_(err));
        return n;
    };

    const saveFiles = async (n: string) => {
        if (!settings)
            throw new Error(_("Settings of this host are not available"));
        await docker.saveStack(host, settings, n, composeYAML, composeENV, isAdd, stack?.composeFileName || "compose.yaml");
    };

    const afterSave = (n: string) => {
        setEditMode(false);
        if (isAdd) {
            goto(["stack", n], host);
        } else {
            load();
        }
    };

    const deploy = () => perform(async () => {
        const n = checkBeforeSave();
        setName(n);
        await saveFiles(n);
        await runCompose("deploy", docker.actionArgs("deploy"), n);
        await model.refresh(host);
        finish("deploy");
        afterSave(n);
    });

    const save = () => perform(async () => {
        const n = checkBeforeSave();
        setName(n);
        await saveFiles(n);
        await model.refresh(host);
        finish("save");
        afterSave(n);
    });

    const discard = () => {
        setEditMode(false);
        load();
    };

    const deleteStack = () => {
        setShowDelete(false);
        perform(async () => {
            if (!settings)
                return;
            await runCompose("delete", docker.actionArgs("delete"), name);
            await docker.removeStackDir(host, settings, name);
            await model.refresh(host);
            goto([], "");
        });
    };

    /* Rendering */

    if (!isAdd && loadError)
        return (
            <PageSection hasBodyWrapper={false}>
                <EmptyStatePanel title={_("Cannot load stack")} paragraph={loadError}
                                 action={_("Back to stacks")} onAction={() => goto([], "")} />
            </PageSection>
        );

    if (!stack || (!isAdd && !settings))
        return <PageSection hasBodyWrapper={false}><EmptyStatePanel loading title={_("Loading stack")} /></PageSection>;

    const services: LooseObject = parsed.config.services ?? {};
    const envServices: LooseObject = parsed.envConfig.services ?? {};
    const serviceNames = Object.keys(services);
    const urls = stackUrls(parsed.envConfig);
    const networkNames = Object.keys(parsed.config.networks ?? {});
    const multiHost = model.hostList.length > 1;
    const onlineHosts = model.hostList.filter(h => model.hosts.get(h)?.status === "online");

    const breadcrumb = (
        <PageBreadcrumb hasBodyWrapper={false} stickyOnBreakpoint={{ default: "top" }}>
            <Breadcrumb>
                <BreadcrumbItem to="#" onClick={ev => { ev.preventDefault(); goto([], "") }}>{_("Docker stacks")}</BreadcrumbItem>
                <BreadcrumbItem isActive>{isAdd ? _("Compose") : name}</BreadcrumbItem>
            </Breadcrumb>
        </PageBreadcrumb>
    );

    const header = (
        <Flex alignItems={{ default: "alignItemsCenter" }} spaceItems={{ default: "spaceItemsMd" }}>
            <Content component="h1" id="stack-title">{isAdd ? _("Compose") : name}</Content>
            {!isAdd && <StackStatusLabel status={status} isCompact={false} />}
            {!isAdd && multiHost && <span className="pf-v6-u-text-color-subtle">({model.hostDisplayName(host)})</span>}
        </Flex>
    );

    const actionButtons = stack.isManaged && (
        <Flex spaceItems={{ default: "spaceItemsSm" }} id="stack-actions">
            {isEditMode && <>
                <Button variant="primary" id="stack-deploy" isDisabled={processing} isLoading={processing} onClick={deploy}>{_("Deploy")}</Button>
                <Button variant="secondary" id="stack-save" isDisabled={processing} onClick={save}>{_("Save")}</Button>
                {!isAdd && <Button variant="link" id="stack-discard" isDisabled={processing} onClick={discard}>{_("Discard")}</Button>}
            </>}
            {!isEditMode && <>
                <Button variant="secondary" id="stack-edit" isDisabled={processing} onClick={() => setEditMode(true)}>{_("Edit")}</Button>
                {!active && <Button variant="primary" id="stack-start" isDisabled={processing} onClick={() => stackAction("start")}>{_("Start")}</Button>}
                {active && <Button variant="secondary" id="stack-restart" isDisabled={processing} onClick={() => stackAction("restart")}>{_("Restart")}</Button>}
                <Button variant="secondary" id="stack-update" isDisabled={processing} onClick={updateStack}>{_("Update")}</Button>
                {active && <Button variant="secondary" id="stack-stop" isDisabled={processing} onClick={() => stackAction("stop")}>{_("Stop")}</Button>}
                <Dropdown isOpen={kebabOpen} onOpenChange={setKebabOpen} popperProps={{ position: "right" }}
                          toggle={ref => (
                              <MenuToggle ref={ref} variant="plain" id="stack-kebab" aria-label={_("More actions")}
                                          isDisabled={processing} onClick={() => setKebabOpen(!kebabOpen)} icon={<EllipsisVIcon />} />
                          )}>
                    <DropdownList>
                        <DropdownItem id="stack-down" onClick={() => { setKebabOpen(false); stackAction("down") }}>
                            {_("Stop and remove containers")}
                        </DropdownItem>
                        <DropdownItem id="stack-delete" className="pf-m-danger" onClick={() => { setKebabOpen(false); setShowDelete(true) }}>
                            {_("Delete stack")}
                        </DropdownItem>
                    </DropdownList>
                </Dropdown>
            </>}
        </Flex>
    );

    return (
        <>
            {breadcrumb}
            <PageSection hasBodyWrapper={false}>
                <Stack hasGutter>
                    {header}
                    {actionButtons}
                    {urls.length > 0 &&
                        <LabelGroup id="stack-urls" numLabels={10}>
                            {urls.map((u, idx) => (
                                <Label key={idx} variant="outline" icon={<ExternalLinkAltIcon />}
                                       render={({ className, content, componentRef }) =>
                                           <a href={u.url} target="_blank" rel="noopener noreferrer" className={className} ref={componentRef}>{content}</a>}>
                                    {u.display}
                                </Label>
                            ))}
                        </LabelGroup>}
                    {notice && !actionError &&
                        <Alert isInline variant="success" title={notice} id="stack-notice"
                               actionClose={<AlertActionCloseButton onClose={() => setNotice(null)} />} />}
                    {actionError &&
                        <Alert isInline variant="danger" title={actionError} id="stack-error"
                               actionClose={<AlertActionCloseButton onClose={() => setActionError(null)} />} />}
                    {showProgress && terminalsSupported &&
                        <ProgressTerminal id="progress-terminal" progress={progress} height="14em" />}

                    {!stack.isManaged &&
                        <Alert isInline variant="info" id="not-managed"
                               title={_("This stack is not managed here")}>
                            {cockpit.format(_("Its compose file is not in the stacks directory $0. Its configuration: $1"),
                                            settings?.stacksDir ?? "", stack.configFiles || _("unknown"))}
                        </Alert>}

                    {stack.isManaged &&
                        <Grid hasGutter>
                            <GridItem lg={6}>
                                <Stack hasGutter>
                                    {isAdd &&
                                        <Card className="ct-card">
                                            <CardHeader><CardTitle component="h2">{_("General")}</CardTitle></CardHeader>
                                            <CardBody>
                                                <Form isHorizontal onSubmit={ev => ev.preventDefault()}>
                                                    <FormGroup label={_("Stack name")} fieldId="stack-name">
                                                        <TextInput id="stack-name" value={name} placeholder={defaultStackName(parsed.config)}
                                                                   onChange={(_ev, v) => setName(v)}
                                                                   onBlur={() => setName(name.toLowerCase())} />
                                                        <FormHelperText>
                                                            <HelperText>
                                                                <HelperTextItem>{_("Lowercase letters, digits, _ and - only")}</HelperTextItem>
                                                            </HelperText>
                                                        </FormHelperText>
                                                    </FormGroup>
                                                    {multiHost &&
                                                        <FormGroup label={_("Host")} fieldId="stack-host">
                                                            <FormSelect id="stack-host" value={host} onChange={(_ev, v) => setHost(v)}>
                                                                {model.hostList.map(h => (
                                                                    <FormSelectOption key={h} value={h} isDisabled={!onlineHosts.includes(h)}
                                                                                      label={model.hostDisplayName(h)} />
                                                                ))}
                                                            </FormSelect>
                                                        </FormGroup>}
                                                </Form>
                                            </CardBody>
                                        </Card>}

                                    <Content component="h2">{_("Containers")}</Content>
                                    {isEditMode &&
                                        <InputGroup>
                                            <InputGroupItem isFill>
                                                <TextInput id="new-service-name" value={newServiceName}
                                                           placeholder={_("New container name...")}
                                                           aria-label={_("New container name")}
                                                           onChange={(_ev, v) => setNewServiceName(v)}
                                                           onKeyDown={ev => { if (ev.key === "Enter") addService(); }} />
                                            </InputGroupItem>
                                            <InputGroupItem>
                                                <Button variant="secondary" id="add-service" onClick={addService}>{_("Add container")}</Button>
                                            </InputGroupItem>
                                        </InputGroup>}
                                    {serviceNames.map(s => (
                                        <ServiceCard key={s} name={s} stackName={name} host={host} hostname={hostname}
                                                     service={services[s] ?? {}} envService={envServices[s] ?? {}}
                                                     isEditMode={isEditMode} instances={serviceStatus[s]} stats={stats}
                                                     serviceCount={serviceNames.length} networks={networkNames}
                                                     processing={processing}
                                                     onChange={svc => updateConfig(c => { c.services[s] = svc })}
                                                     onRemove={() => updateConfig(c => { delete c.services[s] })}
                                                     onAction={action => serviceAction(action, s)} />
                                    ))}

                                    {isEditMode &&
                                        <Card className="ct-card" id="stack-extra">
                                            <CardHeader><CardTitle component="h2">{_("Extra")}</CardTitle></CardHeader>
                                            <CardBody>
                                                <Form onSubmit={ev => ev.preventDefault()}>
                                                    <FormGroup label={_("URLs")} fieldId="stack-urls-input">
                                                        <ListInput id="stack-urls-input" itemName={_("URL")} placeholder="https://"
                                                                   values={(parsed.config["x-dockge"]?.urls ?? []).map(String)}
                                                                   onChange={v => updateConfig(c => {
                                                                       if (v.length === 0) {
                                                                           if (c["x-dockge"]) {
                                                                               delete c["x-dockge"].urls;
                                                                               if (Object.keys(c["x-dockge"]).length === 0)
                                                                                   delete c["x-dockge"];
                                                                           }
                                                                       } else {
                                                                           c["x-dockge"] = { ...c["x-dockge"], urls: v };
                                                                       }
                                                                   })} />
                                                    </FormGroup>
                                                </Form>
                                            </CardBody>
                                        </Card>}

                                    {!isEditMode && !isAdd && <>
                                        <Content component="h2">{_("Logs")}</Content>
                                        {terminalsSupported && settings
                                            ? <OutputTerminal id="stack-logs" height="22em"
                                                              channelKey={`${host}/${name}/${logsKey}`}
                                                              openChannel={() => docker.composeChannel(host, settings, name, ["logs", "-f", "--tail", "100"])} />
                                            : <Alert isInline variant="warning" title={_("Terminal not available")}>{_("This browser does not support WebGL2.")}</Alert>}
                                    </>}
                                </Stack>
                            </GridItem>
                            <GridItem lg={6}>
                                <Stack hasGutter>
                                    <Content component="h2" id="compose-file-name">{stack.composeFileName || "compose.yaml"}</Content>
                                    <CodeEditor id="compose-editor" language="yaml" value={composeYAML} onChange={onYAMLChange}
                                                readOnly={!isEditMode} ariaLabel={_("Compose file")} minHeight="16em" />
                                    {isEditMode && parsed.error &&
                                        <HelperText id="yaml-error"><HelperTextItem variant="error">{parsed.error}</HelperTextItem></HelperText>}
                                    {isEditMode && <>
                                        <Content component="h2">.env</Content>
                                        <CodeEditor id="env-editor" language="env" value={composeENV} onChange={onENVChange}
                                                    ariaLabel={_("Environment file")} minHeight="6em" />
                                        <Content component="h2">{_("Networks")}</Content>
                                        <Card isCompact>
                                            <CardBody>
                                                <NetworksEditor host={host} networks={parsed.config.networks}
                                                                onChange={n => updateConfig(c => {
                                                                    if (n)
                                                                        c.networks = n;
                                                                    else
                                                                        delete c.networks;
                                                                })} />
                                            </CardBody>
                                        </Card>
                                    </>}
                                </Stack>
                            </GridItem>
                        </Grid>}
                </Stack>
            </PageSection>
            {showDelete && <DeleteModal name={name} onConfirm={deleteStack} onClose={() => setShowDelete(false)} />}
        </>
    );
};
