/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Full page terminals: a shell inside a service container, and the
 * stacks directory console.
 */

import React, { useState } from 'react';
import { Breadcrumb, BreadcrumbItem } from "@patternfly/react-core/dist/esm/components/Breadcrumb/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Content } from "@patternfly/react-core/dist/esm/components/Content/index.js";
import { PageBreadcrumb, PageSection } from "@patternfly/react-core/dist/esm/components/Page/index.js";
import { Flex } from "@patternfly/react-core/dist/esm/layouts/Flex/index.js";
import { Stack } from "@patternfly/react-core/dist/esm/layouts/Stack/index.js";

import cockpit from 'cockpit';
import { EmptyStatePanel } from "cockpit-components-empty-state.jsx";

import * as docker from './docker';
import type { Host } from './docker';
import { InteractiveTerminal, canUseTerminal } from './Terminals';
import { Model, goto } from './model';

const _ = cockpit.gettext;

const NoTerminal = () => (
    <EmptyStatePanel title={_("Terminal not available")} paragraph={_("This browser does not support WebGL2.")} />
);

export const ContainerTerminalPage = ({ model, host, stackName, service, shell }: {
    model: Model,
    host: Host,
    stackName: string,
    service: string,
    shell: string,
}) => {
    const [generation, setGeneration] = useState(0);
    const settings = model.settingsFor(host);
    const otherShell = shell === "bash" ? "sh" : "bash";

    return (
        <>
            <PageBreadcrumb hasBodyWrapper={false}>
                <Breadcrumb>
                    <BreadcrumbItem to="#" onClick={ev => { ev.preventDefault(); goto([], "") }}>{_("Docker stacks")}</BreadcrumbItem>
                    <BreadcrumbItem to="#" onClick={ev => { ev.preventDefault(); goto(["stack", stackName], host) }}>{stackName}</BreadcrumbItem>
                    <BreadcrumbItem isActive>{cockpit.format(_("Terminal: $0"), service)}</BreadcrumbItem>
                </Breadcrumb>
            </PageBreadcrumb>
            <PageSection hasBodyWrapper={false}>
                <Stack hasGutter>
                    <Content component="h1">{cockpit.format(_("Terminal - $0 ($1)"), service, stackName)}</Content>
                    <Flex spaceItems={{ default: "spaceItemsSm" }}>
                        <Button variant="secondary" id="switch-shell"
                                onClick={() => goto(["stack", stackName, "terminal", service], host, { shell: otherShell })}>
                            {cockpit.format(_("Switch to $0"), otherShell)}
                        </Button>
                        <Button variant="secondary" id="reconnect" onClick={() => setGeneration(g => g + 1)}>{_("Reconnect")}</Button>
                    </Flex>
                    {!settings
                        ? <EmptyStatePanel loading />
                        : canUseTerminal()
                            ? <InteractiveTerminal id="container-terminal" height="calc(100vh - 16rem)"
                                                   channelKey={`${host}/${stackName}/${service}/${shell}/${generation}`}
                                                   openChannel={() => docker.composeChannel(host, settings, stackName, ["exec", service, shell])} />
                            : <NoTerminal />}
                </Stack>
            </PageSection>
        </>
    );
};

export const ConsolePage = ({ model, host }: { model: Model, host: Host }) => {
    const [generation, setGeneration] = useState(0);
    const settings = model.settingsFor(host);

    let body;
    if (!settings)
        body = <EmptyStatePanel loading />;
    else if (!settings.enableConsole)
        body = (
            <EmptyStatePanel title={_("Console is not enabled")}
                             paragraph={_("The console gives a shell in the stacks directory. It can be enabled in the settings.")} />
        );
    else if (!canUseTerminal())
        body = <NoTerminal />;
    else
        body = (
            <InteractiveTerminal id="console-terminal" height="calc(100vh - 14rem)"
                                 channelKey={`${host}/${generation}`}
                                 openChannel={() => docker.openPtyChannel(host, docker.consoleArgv(), settings.stacksDir)} />
        );

    return (
        <>
            <PageBreadcrumb hasBodyWrapper={false}>
                <Breadcrumb>
                    <BreadcrumbItem to="#" onClick={ev => { ev.preventDefault(); goto([], "") }}>{_("Docker stacks")}</BreadcrumbItem>
                    <BreadcrumbItem isActive>{_("Console")}</BreadcrumbItem>
                </Breadcrumb>
            </PageBreadcrumb>
            <PageSection hasBodyWrapper={false}>
                <Stack hasGutter>
                    <Flex justifyContent={{ default: "justifyContentSpaceBetween" }}>
                        <Content component="h1">{cockpit.format(_("Console ($0)"), model.hostDisplayName(host))}</Content>
                        {settings?.enableConsole && <Button variant="secondary" onClick={() => setGeneration(g => g + 1)}>{_("Reconnect")}</Button>}
                    </Flex>
                    {body}
                </Stack>
            </PageSection>
        </>
    );
};
