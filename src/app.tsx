/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Routing between the pages. Locations follow Cockpit conventions
 * (cockpit.location), with the managed host as a "host" option:
 *
 *   /                                   overview
 *   /new                                compose a new stack
 *   /stack/NAME                         a stack
 *   /stack/NAME/terminal/SERVICE        shell in a service container (?shell=bash|sh)
 *   /console                            shell in the stacks directory
 */

import React, { useEffect, useMemo } from 'react';
import { Page } from '@patternfly/react-core/dist/esm/components/Page/index.js';

import cockpit from 'cockpit';
import { usePageLocation } from "hooks";
import { WithDialogs } from "dialogs.jsx";

import { Model, useModel } from './model';
import { Overview } from './Overview';
import { StackPage } from './StackPage';
import { ConsolePage, ContainerTerminalPage } from './TerminalPages';

export const Application = () => {
    const model = useMemo(() => new Model(), []);
    useModel(model);
    const { path, options } = usePageLocation();

    useEffect(() => {
        model.init();
        return () => model.close();
    }, [model]);

    const host = typeof options.host === "string" ? options.host : "";

    let page;
    if (path[0] === "new") {
        page = <StackPage key="new" model={model} host={host} name="" isAdd />;
    } else if (path[0] === "stack" && path[1] && path[2] === "terminal" && path[3]) {
        const shell = options.shell === "sh" ? "sh" : "bash";
        page = <ContainerTerminalPage model={model} host={host} stackName={path[1]} service={path[3]} shell={shell} />;
    } else if (path[0] === "stack" && path[1]) {
        page = <StackPage key={host + "/" + path[1]} model={model} host={host} name={path[1]} isAdd={false} />;
    } else if (path[0] === "console") {
        page = <ConsolePage model={model} host={host} />;
    } else {
        if (path.length > 0)
            cockpit.location.replace([]);
        page = <Overview model={model} />;
    }

    return (
        <WithDialogs>
            <Page id="docker-stacks" className="no-masthead-sidebar">
                {page}
            </Page>
        </WithDialogs>
    );
};
