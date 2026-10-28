/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * One service ("container" in Dockge) of a stack: status, ports, stats,
 * per-service actions, and a form editor for the common compose keys.
 */

import React, { useState } from 'react';
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardHeader, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Content } from "@patternfly/react-core/dist/esm/components/Content/index.js";
import { Checkbox } from "@patternfly/react-core/dist/esm/components/Checkbox/index.js";
import { ExpandableSection } from "@patternfly/react-core/dist/esm/components/ExpandableSection/index.js";
import { Form, FormGroup } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { FormSelect, FormSelectOption } from "@patternfly/react-core/dist/esm/components/FormSelect/index.js";
import { Label, LabelGroup } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";
import { Flex } from "@patternfly/react-core/dist/esm/layouts/Flex/index.js";
import { Stack } from "@patternfly/react-core/dist/esm/layouts/Stack/index.js";
import { Table, Tbody, Td, Th, Thead, Tr } from "@patternfly/react-table/dist/esm/components/Table/index.js";
import { ExternalLinkAltIcon } from '@patternfly/react-icons';

import cockpit from 'cockpit';

import type { Host, ServiceAction, ServiceUpdate } from './docker';
import { ListInput } from './ListInput';
import { ContainerStatusLabel, UpdateLabel } from './StatusLabel';
import { goto } from './model';
import { isRunningStatus, parseDockerPort, serviceNetworks, splitImage, toStringList } from './util';
import type { ContainerStats, LooseObject, ServiceInstance } from './util';

const _ = cockpit.gettext;

const restartPolicies = [
    ["always", _("Always")],
    ["unless-stopped", _("Unless stopped")],
    ["on-failure", _("On failure")],
    ["no", _("No")],
];

const ServiceEditor = ({ name, service, networks, onChange }: {
    name: string,
    service: LooseObject,
    networks: string[],
    onChange: (service: LooseObject) => void,
}) => {
    const id = "service-" + name;
    const set = (key: string, value: unknown) => {
        const copy = { ...service };
        if (value === "" || value === undefined || (Array.isArray(value) && value.length === 0))
            delete copy[key];
        else
            copy[key] = value;
        onChange(copy);
    };
    const selectedNetworks = serviceNetworks(service.networks);

    return (
        <Form isHorizontal className="service-editor" onSubmit={ev => ev.preventDefault()}>
            <FormGroup label={_("Image")} fieldId={id + "-image"}>
                <TextInput id={id + "-image"} value={service.image ?? ""} placeholder="nginx:latest"
                           onChange={(_ev, v) => set("image", v)} />
            </FormGroup>
            <FormGroup label={_("Ports")} fieldId={id + "-ports"}>
                <ListInput id={id + "-ports"} itemName={_("port")} placeholder="HOST:CONTAINER"
                           values={toStringList(service.ports)} onChange={v => set("ports", v)} />
            </FormGroup>
            <FormGroup label={_("Volumes")} fieldId={id + "-volumes"}>
                <ListInput id={id + "-volumes"} itemName={_("volume")} placeholder="HOST:CONTAINER"
                           values={toStringList(service.volumes)} onChange={v => set("volumes", v)} />
            </FormGroup>
            <FormGroup label={_("Restart policy")} fieldId={id + "-restart"}>
                <FormSelect id={id + "-restart"} value={service.restart ?? ""} onChange={(_ev, v) => set("restart", v)}>
                    <FormSelectOption value="" label={_("Default (no)")} />
                    {restartPolicies.map(([value, label]) => <FormSelectOption key={value} value={value} label={label} />)}
                </FormSelect>
            </FormGroup>
            <FormGroup label={_("Environment variables")} fieldId={id + "-environment"}>
                <ListInput id={id + "-environment"} itemName={_("variable")} placeholder="KEY=VALUE"
                           values={toStringList(service.environment)} onChange={v => set("environment", v)} />
            </FormGroup>
            <FormGroup label={_("Container name")} fieldId={id + "-container-name"}>
                <TextInput id={id + "-container-name"} value={service.container_name ?? ""}
                           onChange={(_ev, v) => set("container_name", v)} />
            </FormGroup>
            {networks.length > 0 &&
                <FormGroup label={_("Networks")} fieldId={id + "-networks"} role="group" isStack>
                    {networks.map(net => (
                        <Checkbox key={net} id={`${id}-network-${net}`} label={net}
                                  isChecked={selectedNetworks.includes(net)}
                                  onChange={(_ev, checked) => set("networks", checked
                                      ? [...selectedNetworks, net]
                                      : selectedNetworks.filter(n => n !== net))} />
                    ))}
                </FormGroup>}
            <FormGroup label={_("Depends on")} fieldId={id + "-depends-on"}>
                <ListInput id={id + "-depends-on"} itemName={_("service")} placeholder={_("Service name")}
                           values={Array.isArray(service.depends_on) ? service.depends_on.map(String) : Object.keys(service.depends_on ?? {})}
                           onChange={v => set("depends_on", v)} />
            </FormGroup>
        </Form>
    );
};

const StatsTable = ({ stats }: { stats: ContainerStats[] }) => (
    <Table variant="compact" aria-label={_("Container statistics")} className="service-stats-table">
        <Thead>
            <Tr>
                <Th>{_("Container")}</Th>
                <Th>{_("CPU")}</Th>
                <Th>{_("Memory")}</Th>
                <Th>{_("Network I/O")}</Th>
                <Th>{_("Block I/O")}</Th>
                <Th>{_("PIDs")}</Th>
            </Tr>
        </Thead>
        <Tbody>
            {stats.map(s => (
                <Tr key={s.Name}>
                    <Td dataLabel={_("Container")}>{s.Name}</Td>
                    <Td dataLabel={_("CPU")}>{s.CPUPerc}</Td>
                    <Td dataLabel={_("Memory")}>{s.MemUsage} ({s.MemPerc})</Td>
                    <Td dataLabel={_("Network I/O")}>{s.NetIO}</Td>
                    <Td dataLabel={_("Block I/O")}>{s.BlockIO}</Td>
                    <Td dataLabel={_("PIDs")}>{s.PIDs}</Td>
                </Tr>
            ))}
        </Tbody>
    </Table>
);

export const ServiceCard = ({
    name, stackName, host, hostname, service, envService, isEditMode, instances, stats, serviceCount,
    networks, processing, updates, onChange, onRemove, onAction,
}: {
    name: string,
    stackName: string,
    host: Host,
    hostname: string,
    service: LooseObject,
    envService: LooseObject,
    isEditMode: boolean,
    instances: ServiceInstance[] | undefined,
    stats: Record<string, ContainerStats>,
    serviceCount: number,
    networks: string[],
    processing: boolean,
    updates: ServiceUpdate[],
    onChange: (service: LooseObject) => void,
    onRemove: () => void,
    onAction: (action: ServiceAction) => void,
}) => {
    const [showEditor, setShowEditor] = useState(false);
    const [showStats, setShowStats] = useState(false);

    const image = splitImage(envService.image);
    const status = instances?.[0]?.status;
    const running = isRunningStatus(status);
    const ports = Array.isArray(envService.ports) ? envService.ports : [];
    const statsInstances = (instances ?? [])
            .map(i => stats[i.name])
            .filter((s): s is ContainerStats => !!s)
            .sort((a, b) => a.Name.localeCompare(b.Name));

    const actions = !isEditMode && (
        <Flex spaceItems={{ default: "spaceItemsSm" }}>
            {running &&
                <Button variant="secondary" size="sm" className="service-terminal"
                        onClick={() => goto(["stack", stackName, "terminal", name], host, { shell: "bash" })}>
                    {_("Terminal")}
                </Button>}
            {serviceCount > 1 && !running &&
                <Button variant="secondary" size="sm" isDisabled={processing} className="service-start"
                        onClick={() => onAction("start")}>{_("Start")}</Button>}
            {serviceCount > 1 && (running || status === "unhealthy") && <>
                <Button variant="secondary" size="sm" isDisabled={processing} className="service-restart"
                        onClick={() => onAction("restart")}>{_("Restart")}</Button>
                <Button variant="secondary" size="sm" isDisabled={processing} className="service-stop"
                        onClick={() => onAction("stop")}>{_("Stop")}</Button>
            </>}
        </Flex>
    );

    return (
        <Card isCompact className="service-card" data-service={name}>
            <CardHeader {...actions ? { actions: { actions, hasNoOffset: true } } : {}}>
                <CardTitle>
                    <Content component="h3" className="service-name">{name}</Content>
                    <div className="service-image ct-monospace">
                        {image.name ? <>{image.name}:<strong>{image.tag}</strong></> : <em>{_("No image")}</em>}
                    </div>
                </CardTitle>
            </CardHeader>
            <CardBody>
                <Stack hasGutter>
                    {!isEditMode &&
                        <LabelGroup numLabels={10}>
                            <ContainerStatusLabel status={status} />
                            <UpdateLabel updates={updates} />
                            {ports.map((port: string | LooseObject, idx: number) => {
                                const link = parseDockerPort(port, hostname);
                                return (
                                    <Label key={idx} isCompact variant="outline" icon={<ExternalLinkAltIcon />}
                                           className="service-port"
                                           render={({ className, content, componentRef }) =>
                                               <a href={link.url} target="_blank" rel="noopener noreferrer"
                                                  className={className} ref={componentRef}>{content}</a>}>
                                        {link.display}
                                    </Label>
                                );
                            })}
                        </LabelGroup>}
                    {!isEditMode && statsInstances.length > 0 &&
                        <ExpandableSection toggleText={showStats
                            ? _("Hide statistics")
                            : cockpit.format(_("CPU: $0, Memory: $1"), statsInstances[0].CPUPerc, statsInstances[0].MemUsage)}
                                           isExpanded={showStats} onToggle={(_ev, v) => setShowStats(v)}
                                           className="service-stats">
                            <StatsTable stats={statsInstances} />
                        </ExpandableSection>}
                    {isEditMode && <>
                        <Flex spaceItems={{ default: "spaceItemsSm" }}>
                            <Button variant="secondary" size="sm" className="service-edit"
                                    onClick={() => setShowEditor(!showEditor)}>
                                {showEditor ? _("Close editor") : _("Edit")}
                            </Button>
                            <Button variant="danger" size="sm" className="service-delete" onClick={onRemove}>
                                {_("Delete service")}
                            </Button>
                        </Flex>
                        {showEditor && <ServiceEditor name={name} service={service} networks={networks} onChange={onChange} />}
                    </>}
                </Stack>
            </CardBody>
        </Card>
    );
};
