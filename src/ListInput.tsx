/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Editable list of strings (ports, volumes, environment, ...), like Dockge's ArrayInput.
 */

import React from 'react';
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";
import { Flex, FlexItem } from "@patternfly/react-core/dist/esm/layouts/Flex/index.js";
import { Stack } from "@patternfly/react-core/dist/esm/layouts/Stack/index.js";
import { MinusIcon, PlusIcon } from '@patternfly/react-icons';

import cockpit from 'cockpit';

const _ = cockpit.gettext;

export const ListInput = ({ id, values, onChange, placeholder, itemName }: {
    id: string,
    values: string[],
    onChange: (values: string[]) => void,
    placeholder?: string,
    itemName: string,
}) => {
    const set = (idx: number, value: string) => onChange(values.map((v, i) => i === idx ? value : v));
    const remove = (idx: number) => onChange(values.filter((_v, i) => i !== idx));

    return (
        <Stack id={id} className="list-input">
            {values.map((value, idx) => (
                <Flex key={idx} spaceItems={{ default: "spaceItemsSm" }} flexWrap={{ default: "nowrap" }} className="list-input-row">
                    <FlexItem grow={{ default: "grow" }}>
                        <TextInput id={`${id}-${idx}`} value={value} placeholder={placeholder ?? ""}
                                   aria-label={cockpit.format(_("$0 $1"), itemName, idx + 1)}
                                   onChange={(_ev, v) => set(idx, v)} />
                    </FlexItem>
                    <Button variant="plain" aria-label={cockpit.format(_("Remove $0"), itemName)} icon={<MinusIcon />}
                            onClick={() => remove(idx)} />
                </Flex>
            ))}
            <div>
                <Button variant="link" isInline icon={<PlusIcon />} className="list-input-add"
                        onClick={() => onChange([...values, ""])}>
                    {cockpit.format(_("Add $0"), itemName)}
                </Button>
            </div>
        </Stack>
    );
};
