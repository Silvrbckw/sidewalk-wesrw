// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as path from 'path';
import { Uri } from 'vscode';
import { uniq } from 'lodash';
import {
    PythonEnvInfo,
    PythonEnvKind,
    PythonEnvSource,
    PythonEnvType,
    UNKNOWN_PYTHON_VERSION,
    virtualEnvKinds,
} from '../../info';
import { buildEnvInfo, comparePythonVersionSpecificity, setEnvDisplayString, getEnvID } from '../../info/env';
import { getEnvironmentDirFromPath, getPythonVersionFromPath } from '../../../common/commonUtils';
import { arePathsSame, getFileInfo, isParentPath } from '../../../common/externalDependencies';
import { AnacondaCompanyName, Conda, isCondaEnvironment } from '../../../common/environmentManagers/conda';
import { getPyenvVersionsDir, parsePyenvVersion } from '../../../common/environmentManagers/pyenv';
import { Architecture, getOSType, OSType } from '../../../../common/utils/platform';
import { getPythonVersionFromPath as parsePythonVersionFromPath, parseVersion } from '../../info/pythonVersion';
import { getRegistryInterpreters, getRegistryInterpretersSync } from '../../../common/windowsUtils';
import { BasicEnvInfo } from '../../locator';
import { parseVersionFromExecutable } from '../../info/executable';
import { traceError, traceWarn } from '../../../../logging';
import { isVirtualEnvironment } from '../../../common/environmentManagers/simplevirtualenvs';
import { getWorkspaceFolderPaths } from '../../../../common/vscodeApis/workspaceApis';

function getResolvers(): Map<PythonEnvKind, (env: BasicEnvInfo) => Promise<PythonEnvInfo>> {
    const resolvers = new Map<PythonEnvKind, (_: BasicEnvInfo) => Promise<PythonEnvInfo>>();
    Object.values(PythonEnvKind).forEach((k) => {
        resolvers.set(k, resolveGloballyInstalledEnv);
    });
    virtualEnvKinds.forEach((k) => {
        resolvers.set(k, resolveSimpleEnv);
    });
    resolvers.set(PythonEnvKind.Conda, resolveCondaEnv);
    resolvers.set(PythonEnvKind.MicrosoftStore, resolveMicrosoftStoreEnv);
    resolvers.set(PythonEnvKind.Pyenv, resolvePyenvEnv);
    return resolvers;
}

/**
 * Find as much info about the given Basic Python env as possible without running the
 * executable and returns it. Notice `undefined` is never returned, so environment
 * returned could still be invalid.
 */
export async function resolveBasicEnv(env: BasicEnvInfo): Promise<PythonEnvInfo> {
    const { kind, source } = env;
    const resolvers = getResolvers();
    const resolverForKind = resolvers.get(kind)!;
    const resolvedEnv = await resolverForKind(env);
    resolvedEnv.searchLocation = getSearchLocation(resolvedEnv);
    resolvedEnv.source = uniq(resolvedEnv.source.concat(source ?? []));
    if (getOSType() === OSType.Windows && resolvedEnv.source?.includes(PythonEnvSource.WindowsRegistry)) {
        // We can update env further using information we can get from the Windows registry.
        await updateEnvUsingRegistry(resolvedEnv);
    }
    setEnvDisplayString(resolvedEnv);
    resolvedEnv.id = getEnvID(resolvedEnv.executable.filename, resolvedEnv.location);
    const { ctime, mtime } = await getFileInfo(resolvedEnv.executable.filename);
    resolvedEnv.executable.ctime = ctime;
    resolvedEnv.executable.mtime = mtime;
    const type = await getEnvType(resolvedEnv);
    if (type) {
        resolvedEnv.type = type;
    }
    return resolvedEnv;
}

async function getEnvType(env: PythonEnvInfo) {
    if (env.type) {
        return env.type;
    }
    if (await isVirtualEnvironment(env.executable.filename)) {
        return PythonEnvType.Virtual;
    }
    if (await isCondaEnvironment(env.executable.filename)) {
        return PythonEnvType.Conda;
    }
    return undefined;
}

function getSearchLocation(env: PythonEnvInfo): Uri | undefined {
    const folders = getWorkspaceFolderPaths();
    const isRootedEnv = folders.some((f) => isParentPath(env.executable.filename, f) || isParentPath(env.location, f));
    if (isRootedEnv) {
        // For environments inside roots, we need to set search location so they can be queried accordingly.
        // In certain usecases environment directory can itself be a root, for eg. `python -m venv .`.
        // So choose folder to environment path to search for this env.
        //
        // |__ env <--- Default search location directory
        //    |__ bin or Scripts
        //        |__ python  <--- executable
        return Uri.file(env.location);
    }
    return undefined;
}

async function updateEnvUsingRegistry(env: PythonEnvInfo): Promise<void> {
    // Environment source has already been identified as windows registry, so we expect windows registry
    // cache to already be populated. Call sync function which relies on cache.
    let interpreters = getRegistryInterpretersSync();
    if (!interpreters) {
        traceError('Expected registry interpreter cache to be initialized already');
        interpreters = await getRegistryInterpreters();
    }
    const data = interpreters.find((i) => arePathsSame(i.interpreterPath, env.executable.filename));
    if (data) {
        const versionStr = data.versionStr ?? data.sysVersionStr ?? data.interpreterPath;
        let version;
        try {
            version = parseVersion(versionStr);
        } catch (ex) {
            version = UNKNOWN_PYTHON_VERSION;
        }
        env.kind = env.kind === PythonEnvKind.Unknown ? PythonEnvKind.OtherGlobal : env.kind;
        env.version = comparePythonVersionSpecificity(version, env.version) > 0 ? version : env.version;
        env.distro.defaultDisplayName = data.companyDisplayName;
        env.arch = data.bitnessStr === '32bit' ? Architecture.x86 : Architecture.x64;
        env.distro.org = data.distroOrgName ?? env.distro.org;
        env.source = uniq(env.source.concat(PythonEnvSource.WindowsRegistry));
    } else {
        traceWarn('Expected registry to find the interpreter as source was set');
    }
}

async function resolveGloballyInstalledEnv(env: BasicEnvInfo): Promise<PythonEnvInfo> {
    const { executablePath } = env;
    let version;
    try {
        version = parseVersionFromExecutable(executablePath);
    } catch {
        version = UNKNOWN_PYTHON_VERSION;
    }
    const envInfo = buildEnvInfo({
        kind: env.kind,
        version,
        executable: executablePath,
    });
    return envInfo;
}

async function resolveSimpleEnv(env: BasicEnvInfo): Promise<PythonEnvInfo> {
    const { executablePath, kind } = env;
    const envInfo = buildEnvInfo({
        kind,
        version: await getPythonVersionFromPath(executablePath),
        executable: executablePath,
        type: PythonEnvType.Virtual,
    });
    const location = getEnvironmentDirFromPath(executablePath);
    envInfo.location = location;
    envInfo.name = path.basename(location);
    return envInfo;
}

async function resolveCondaEnv(env: BasicEnvInfo): Promise<PythonEnvInfo> {
    const { executablePath } = env;
    const conda = await Conda.getConda();
    if (conda === undefined) {
        traceWarn(`${executablePath} identified as Conda environment even though Conda is not found`);
        // Environment could still be valid, resolve as a simple env.
        env.kind = PythonEnvKind.Unknown;
        const envInfo = await resolveSimpleEnv(env);
        envInfo.type = PythonEnvType.Conda;
        // Assume it's a prefixed env by default because prefixed CLIs work even for named environments.
        envInfo.name = '';
        return envInfo;
    }

    const envPath = env.envPath ?? getEnvironmentDirFromPath(env.executablePath);
    let executable: string;
    if (env.executablePath.length > 0) {
        executable = env.executablePath;
    } else {
        executable = await conda.getInterpreterPathForEnvironment({ prefix: envPath });
    }
    const info = buildEnvInfo({
        executable,
        kind: PythonEnvKind.Conda,
        org: AnacondaCompanyName,
        location: envPath,
        source: [],
        version: executable ? await getPythonVersionFromPath(executable) : undefined,
        type: PythonEnvType.Conda,
    });
    const name = await conda?.getName(envPath);
    if (name) {
        info.name = name;
    }
    return info;
}

async function resolvePyenvEnv(env: BasicEnvInfo): Promise<PythonEnvInfo> {
    const { executablePath } = env;
    const location = getEnvironmentDirFromPath(executablePath);
    const name = path.basename(location);

    // The sub-directory name sometimes can contain distro and python versions.
    // here we attempt to extract the texts out of the name.
    const versionStrings = parsePyenvVersion(name);

    const envInfo = buildEnvInfo({
        kind: PythonEnvKind.Pyenv,
        executable: executablePath,
        source: [],
        location,
        // Pyenv environments can fall in to these three categories:
        // 1. Global Installs : These are environments that are created when you install
        //    a supported python distribution using `pyenv install <distro>` command.
        //    These behave similar to globally installed version of python or distribution.
        //
        // 2. Virtual Envs    : These are environments that are created when you use
        //    `pyenv virtualenv <distro> <env-name>`. These are similar to environments
        //    created using `python -m venv <env-name>`.
        //
        // 3. Conda Envs      : These are environments that are created when you use
        //    `pyenv virtualenv <miniconda|anaconda> <env-name>`. These are similar to
        //    environments created using `conda create -n <env-name>.
        //
        // All these environments are fully handled by `pyenv` and should be activated using
        // `pyenv local|global <env-name>` or `pyenv shell <env-name>`
        //
        // Here we look for near by files, or config files to see if we can get python version info
        // without running python itself.
        version: await getPythonVersionFromPath(executablePath, versionStrings?.pythonVer),
        org: versionStrings && versionStrings.distro ? versionStrings.distro : '',
    });

    if (await isBaseCondaPyenvEnvironment(executablePath)) {
        envInfo.name = 'base';
    } else {
        envInfo.name = name;
    }
    return envInfo;
}

async function isBaseCondaPyenvEnvironment(executablePath: string) {
    if (!(await isCondaEnvironment(executablePath))) {
        return false;
    }
    const location = getEnvironmentDirFromPath(executablePath);
    const pyenvVersionDir = getPyenvVersionsDir();
    return arePathsSame(path.dirname(location), pyenvVersionDir);
}

async function resolveMicrosoftStoreEnv(env: BasicEnvInfo): Promise<PythonEnvInfo> {
    const { executablePath } = env;
    return buildEnvInfo({
        kind: PythonEnvKind.MicrosoftStore,
        executable: executablePath,
        version: parsePythonVersionFromPath(executablePath),
        org: 'Microsoft',
        arch: Architecture.x64,
        source: [PythonEnvSource.PathEnvVar],
    });
}
