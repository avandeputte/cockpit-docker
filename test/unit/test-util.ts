/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Unit tests for the pure helpers; run with "npm test".
 */

import QUnit from "qunit";

import {
    CREATED_FILE, CREATED_STACK, EXITED, RUNNING, UNKNOWN,
    composeToYAML, defaultStackName, dockerRunToCompose, envsubst, envsubstYAML, hostnameOf, matchesStatusFilter,
    parseCompose, parseComposePs, parseDockerPort, parseDockerStats, parseDotenv, splitImage, stackUrls, statusClass,
    statusConvert, toStringList, validateEnv, validateStackName,
    bindSourceFor, formatVolume, isBindSource, isReadOnlyMode, parentDirectory, parseVolume, resolveHostPath, setReadOnlyMode,
} from "../../src/util.ts";

QUnit.module("status", () => {
    QUnit.test("statusConvert", assert => {
        assert.equal(statusConvert("running(2)"), RUNNING);
        assert.equal(statusConvert("exited(1), running(1)"), EXITED);
        assert.equal(statusConvert("created(1)"), CREATED_STACK);
        assert.equal(statusConvert("paused(1)"), UNKNOWN);
    });

    QUnit.test("statusClass and filters", assert => {
        assert.equal(statusClass(RUNNING), "active");
        assert.equal(statusClass(EXITED), "exited");
        assert.equal(statusClass(CREATED_FILE), "inactive");
        assert.equal(statusClass(CREATED_STACK), "inactive");
        assert.equal(statusClass(UNKNOWN), "unknown");
        assert.true(matchesStatusFilter(RUNNING, "all"));
        assert.true(matchesStatusFilter(CREATED_FILE, "inactive"));
        assert.false(matchesStatusFilter(EXITED, "active"));
    });
});

QUnit.module("validation", () => {
    QUnit.test("stack names", assert => {
        assert.equal(validateStackName("my-stack_1"), null);
        assert.notEqual(validateStackName("My Stack"), null);
        assert.notEqual(validateStackName("../etc"), null);
        assert.notEqual(validateStackName(""), null);
    });

    QUnit.test(".env", assert => {
        assert.equal(validateEnv("A=1\nB=2"), null);
        assert.equal(validateEnv(""), null);
        assert.notEqual(validateEnv("garbage"), null);
    });
});

QUnit.module("environment", () => {
    QUnit.test("parseDotenv", assert => {
        assert.deepEqual(parseDotenv("# comment\nA=1\nexport B = two # trailing\nC=\"quoted # not comment\"\nD='single'\nEMPTY=\n"),
                         { A: "1", B: "two", C: "quoted # not comment", D: "single", EMPTY: "" });
    });

    QUnit.test("envsubst", assert => {
        const env = { PORT: "8081", EMPTY: "" };
        assert.equal(envsubst("${PORT}:80", env), "8081:80");
        assert.equal(envsubst("$PORT", env), "8081");
        assert.equal(envsubst("${MISSING:-8080}:80", env), "8080:80");
        assert.equal(envsubst("${EMPTY:-def}", env), "def");
        assert.equal(envsubst("${EMPTY-def}", env), "");
        assert.equal(envsubst("${PORT:+set}", env), "set");
        assert.equal(envsubst("$${PORT}", env), "$${PORT}");
    });

    QUnit.test("envsubstYAML", assert => {
        const out = envsubstYAML("services:\n  web:\n    image: nginx:${TAG:-latest}\n    ports:\n      - \"${PORT}:80\"\n", { PORT: "9000" });
        const { config } = parseCompose(out);
        assert.equal(config.services.web.image, "nginx:latest");
        assert.deepEqual(config.services.web.ports, ["9000:80"]);
    });
});

QUnit.module("compose YAML", () => {
    QUnit.test("parseCompose", assert => {
        assert.deepEqual(parseCompose("").config, { services: {} });
        assert.throws(() => parseCompose("services: [a, b]"), /Services must be an object/);
        assert.throws(() => parseCompose("services:\n  a: [\n"));
    });

    QUnit.test("composeToYAML keeps comments and quoting", assert => {
        const src = "# demo stack\nservices:\n  # the web server\n  nginx:\n    image: nginx # pinned\n    ports:\n      - \"8080:80\" # http\n";
        const { config, doc } = parseCompose(src);
        config.services.nginx.image = "nginx:alpine";
        config.services.nginx.ports.push("8443:443");
        const { yaml } = composeToYAML(config, doc);
        assert.true(yaml.startsWith("# demo stack\n"), yaml);
        assert.true(yaml.includes("# the web server"), yaml);
        assert.true(yaml.includes("image: nginx:alpine # pinned"), yaml);
        assert.true(yaml.includes("- \"8080:80\" # http"), yaml);
        assert.true(yaml.includes("- \"8443:443\""), yaml);
        assert.deepEqual(parseCompose(yaml).config, config);
    });

    QUnit.test("defaultStackName", assert => {
        assert.equal(defaultStackName({ services: { Web: {} } }), "web");
        assert.equal(defaultStackName({ services: { web: { container_name: "MyApp" } } }), "myapp");
        assert.equal(defaultStackName({ services: {} }), "");
    });

    QUnit.test("stackUrls", assert => {
        assert.deepEqual(stackUrls({ "x-dockge": { urls: ["https://example.com/", "http://h:8080/app?x=1", ""] } }), [
            { url: "https://example.com/", display: "example.com" },
            { url: "http://h:8080/app?x=1", display: "h:8080/app?x=1" },
        ]);
        assert.deepEqual(stackUrls({}), []);
    });

    QUnit.test("toStringList", assert => {
        assert.deepEqual(toStringList({ A: 1, B: null }), ["A=1", "B"]);
        assert.deepEqual(toStringList(["A=1"]), ["A=1"]);
        assert.deepEqual(toStringList(undefined), []);
    });

    QUnit.test("splitImage", assert => {
        assert.deepEqual(splitImage("nginx"), { name: "nginx", tag: "latest" });
        assert.deepEqual(splitImage("nginx:1.25"), { name: "nginx", tag: "1.25" });
        assert.deepEqual(splitImage("registry:5000/team/app"), { name: "registry:5000/team/app", tag: "latest" });
        assert.deepEqual(splitImage("registry:5000/app:v1"), { name: "registry:5000/app", tag: "v1" });
    });
});

QUnit.module("docker output", () => {
    QUnit.test("parseDockerPort", assert => {
        const h = "server";
        assert.deepEqual(parseDockerPort("3000", h), { url: "http://server:3000", display: "3000" });
        assert.deepEqual(parseDockerPort("3000-3005", h), { url: "http://server:3000", display: "3000-3005" });
        assert.deepEqual(parseDockerPort("8000:8000", h), { url: "http://server:8000", display: "8000" });
        assert.deepEqual(parseDockerPort("9090-9091:8080-8081", h), { url: "http://server:9090", display: "9090-9091" });
        assert.deepEqual(parseDockerPort("127.0.0.1:8001:8001", h), { url: "http://127.0.0.1:8001", display: "127.0.0.1:8001" });
        assert.deepEqual(parseDockerPort("0.0.0.0:8080->8080/tcp", h), { url: "http://server:8080", display: "8080" });
        assert.deepEqual(parseDockerPort("443:443", h), { url: "https://server:443", display: "443" });
        assert.deepEqual(parseDockerPort("6060:6060/udp", h), { url: "udp://server:6060", display: "6060" });
        assert.deepEqual(parseDockerPort({ published: 8080, target: 80 }, h), { url: "http://server:8080", display: "8080" });
    });

    QUnit.test("parseComposePs", assert => {
        const lines = '{"Service":"web","State":"running","Health":"","Name":"s-web-1"}\n' +
                      '{"Service":"db","State":"running","Health":"healthy","Name":"s-db-1"}\nWARN something\n';
        assert.deepEqual(parseComposePs(lines), {
            web: [{ status: "running", name: "s-web-1" }],
            db: [{ status: "healthy", name: "s-db-1" }],
        });
        assert.deepEqual(parseComposePs('[{"Service":"a","State":"exited","Name":"x"}]'), { a: [{ status: "exited", name: "x" }] });
    });

    QUnit.test("parseDockerStats", assert => {
        const out = '{"Name":"a","CPUPerc":"0.1%","MemUsage":"1MiB / 2GiB"}\n{"Name":"b","CPUPerc":"2%"}\n';
        const stats = parseDockerStats(out);
        assert.deepEqual(Object.keys(stats), ["a", "b"]);
        assert.equal(stats.a.CPUPerc, "0.1%");
    });

    QUnit.test("hostnameOf", assert => {
        assert.equal(hostnameOf("", "fallback"), "fallback");
        assert.equal(hostnameOf("admin@nas", "x"), "nas");
        assert.equal(hostnameOf("nas:2222", "x"), "nas");
        assert.equal(hostnameOf("me@[fe80::1]:22", "x"), "fe80::1");
    });
});

QUnit.module("docker run conversion", () => {
    QUnit.test("dockerRunToCompose", assert => {
        const yaml = dockerRunToCompose("docker run -d --name web -p 80:80 -v /a:/b -e X=1 --restart always nginx:latest");
        assert.false(yaml.startsWith("name:"));
        const { config } = parseCompose(yaml);
        assert.equal(config.services.nginx.image, "nginx:latest");
        assert.equal(config.services.nginx.container_name, "web");
        assert.deepEqual(config.services.nginx.ports, ["80:80"]);
        assert.equal(config.services.nginx.restart, "always");
        assert.throws(() => dockerRunToCompose("docker run"), /Please enter/);
    });
});

QUnit.module("volumes", () => {
    QUnit.test("parse and format", assert => {
        assert.deepEqual(parseVolume("./data:/data"), { source: "./data", target: "/data", mode: "" });
        assert.deepEqual(parseVolume("db:/var/lib/db:ro,z"), { source: "db", target: "/var/lib/db", mode: "ro,z" });
        assert.deepEqual(parseVolume("/cache"), { source: "", target: "/cache", mode: "" });
        for (const v of ["./data:/data", "db:/var/lib/db:ro,z", "/cache", "/srv:/srv:ro"])
            assert.equal(formatVolume(parseVolume(v)), v);
        assert.equal(formatVolume({ source: "/srv", target: "", mode: "" }), "/srv:");
    });

    QUnit.test("read-only", assert => {
        assert.true(isReadOnlyMode("ro"));
        assert.true(isReadOnlyMode("z,ro"));
        assert.false(isReadOnlyMode("rw"));
        assert.equal(setReadOnlyMode("", true), "ro");
        assert.equal(setReadOnlyMode("rw,z", true), "ro,z");
        assert.equal(setReadOnlyMode("ro,z", false), "z");
    });

    QUnit.test("host paths", assert => {
        assert.true(isBindSource("./data"));
        assert.true(isBindSource("/srv"));
        assert.false(isBindSource("dbdata"));
        assert.equal(parentDirectory("/opt/stacks/web/"), "/opt/stacks");
        assert.equal(parentDirectory("/opt"), "/");
        assert.equal(resolveHostPath("./data", "/opt/stacks/web"), "/opt/stacks/web/data");
        assert.equal(resolveHostPath("../shared", "/opt/stacks/web"), "/opt/stacks/shared");
        assert.equal(resolveHostPath("/srv/media", "/opt/stacks/web"), "/srv/media");
        assert.equal(bindSourceFor("/opt/stacks/web/data", "/opt/stacks/web"), "./data");
        assert.equal(bindSourceFor("/opt/stacks/web", "/opt/stacks/web"), ".");
        assert.equal(bindSourceFor("/opt/stacks/webx", "/opt/stacks/web"), "/opt/stacks/webx");
        assert.equal(bindSourceFor("/srv", "/opt/stacks/web"), "/srv");
    });
});
