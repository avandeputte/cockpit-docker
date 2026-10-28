/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Editor for the top-level "networks" of a compose file, like Dockge's NetworkInput:
 * internal networks are created by the stack, external ones must already exist.
 */

import React, { useEffect, useState } from 'react';
import { Checkbox } from "@patternfly/react-core/dist/esm/components/Checkbox/index.js";
import { Content } from "@patternfly/react-core/dist/esm/components/Content/index.js";
import { Stack } from "@patternfly/react-core/dist/esm/layouts/Stack/index.js";

import cockpit from 'cockpit';

import * as docker from './docker';
import type { Host } from './docker';
import { ListInput } from './ListInput';
import type { LooseObject } from './util';

const _ = cockpit.gettext;

export const NetworksEditor = ({ host, networks, onChange }: {
    host: Host,
    networks: LooseObject | undefined,
    onChange: (networks: LooseObject | undefined) => void,
}) => {
    const [dockerNetworks, setDockerNetworks] = useState<string[]>([]);

    useEffect(() => {
        docker.getNetworkList(host)
                .then(list => setDockerNetworks(list.filter(n => !["bridge", "host", "none"].includes(n))))
                .catch(ex => console.warn("Cannot list docker networks:", docker.errorMessage(ex)));
    }, [host]);

    const current = networks ?? {};
    const isExternal = (name: string) => !!current[name]?.external;
    const internal = Object.keys(current).filter(n => !isExternal(n));
    const external = Object.keys(current).filter(isExternal);
    const externalChoices = [...new Set([...dockerNetworks, ...external])].sort();

    const emit = (next: LooseObject) => onChange(Object.keys(next).length > 0 ? next : undefined);

    const setInternal = (names: string[]) => {
        const next: LooseObject = {};
        names.forEach(n => { next[n] = current[n] ?? {} });
        external.forEach(n => { next[n] = current[n] });
        emit(next);
    };

    const toggleExternal = (name: string, checked: boolean) => {
        const next: LooseObject = { ...current };
        if (checked)
            next[name] = { external: true };
        else
            delete next[name];
        emit(next);
    };

    return (
        <Stack hasGutter id="stack-networks">
            <Content component="h4">{_("Internal networks")}</Content>
            <ListInput id="internal-networks" itemName={_("network")} placeholder={_("Network name")}
                       values={internal} onChange={setInternal} />
            <Content component="h4">{_("External networks")}</Content>
            {externalChoices.length === 0
                ? <Content component="p" className="pf-v6-u-text-color-subtle">{_("No user-defined docker networks exist.")}</Content>
                : externalChoices.map(name => (
                    <Checkbox key={name} id={"external-network-" + name} label={name}
                              isChecked={isExternal(name)} onChange={(_ev, checked) => toggleExternal(name, checked)} />
                ))}
        </Stack>
    );
};
