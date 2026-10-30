import { parseShell, programOf, RUNTIME_OPERAND } from './shell-lab.mjs';

                                                                                                          

const S = (...xs          )                      => new Set(xs);

const NPM_BASE = [
  '--registry', '--userconfig', '--globalconfig', '--cache', '--loglevel', '--location', '--tag', '--otp', '--omit', '--include',
  '--install-strategy', '--store-dir', '--reporter', '--network-concurrency', '--before', '--cafile', '--ca', '--cert', '--key',
  '--proxy', '--https-proxy', '--network-timeout', '--modules-folder', '--cache-folder', '--save-prefix', '--lockfile-dir',
  '--virtual-store-dir', '--node-linker', '--mutex', '--preferred-cache-folder', '--script-shell', '--node-options', '--allow-build',
];
const VALUE                                      = {
  npm: S(...NPM_BASE, '-w', '--workspace', '-C', '--prefix', '--call', '-c', '-p', '--package'),
  pnpm: S(...NPM_BASE, '-C', '--dir', '--filter', '-F', '--filter-prod', '--package', '--config-dir'),
  yarn: S(...NPM_BASE, '--cwd', '--package', '-p'),
  bun: S(...NPM_BASE, '--cwd', '-c', '--config', '--backend', '--package', '-p'),
  deno: S('--config', '-c', '--import-map', '--lock', '--root', '-n', '--name', '--allow-scripts', '--location', '--cert', '--reload', '-r'),
  pypi: S(
    '-r', '--requirement', '-c', '--constraint', '-e', '--editable', '-i', '--index-url', '--extra-index-url', '--index', '--default-index',
    '-f', '--find-links', '-t', '--target', '--prefix', '--root', '--python', '-p', '--platform', '--python-version', '--implementation',
    '--abi', '--src', '--upgrade-strategy', '--progress-bar', '--trusted-host', '--cert', '--client-cert', '--proxy', '--timeout',
    '--retries', '--log', '--cache-dir', '--exists-action', '--no-binary', '--only-binary', '-C', '--config-settings', '--directory',
    '--project', '--group', '-G', '-E', '--extras', '--source', '--suffix', '--python-platform', '--index-strategy', '--keyring-provider',
    '--resolution', '--prerelease', '--exclude-newer', '--allow-insecure-host', '--link-mode', '--refresh-package', '--reinstall-package',
    '--upgrade-package', '-P', '--no-build-package', '--no-binary-package', '--optional', '--rev', '--tag', '--branch', '--script',
    '--package', '--extra', '--with', '--from', '--spec', '--config-file', '--color', '--python-preference',
  ),
  conda: S('-n', '--name', '-p', '--prefix', '-c', '--channel', '--file', '-f', '--subdir', '--platform', '--repodata-fn', '--solver', '-r', '--root-prefix'),
  go: S('-C', '-modfile', '-tags', '-ldflags', '-gcflags', '-o', '-p', '-mod', '-overlay', '-pkgdir'),
  cargo: S(
    '--features', '-F', '--rev', '--branch', '--tag', '--git', '--path', '--registry', '--index', '--version', '--vers', '--root', '--target',
    '-j', '--jobs', '--manifest-path', '--package', '-p', '--rename', '--config', '-Z', '--profile', '--target-dir', '--bin', '--example',
    '--color', '--lockfile-path',
  ),
  rubygems: S('-v', '--version', '-s', '--source', '--platform', '-i', '--install-dir', '-n', '--bindir', '--document', '-g', '--file', '--build-root', '-P', '--trust-policy'),
  bundle: S('-v', '--version', '-g', '--group', '-s', '--source', '-r', '--require', '--path', '--git', '--github', '--branch', '--ref', '--glob'),
  composer: S('-d', '--working-dir'),
  nuget: S('-version', '-source', '-outputdirectory', '-o', '-configfile', '-framework', '-fallbacksource', '-packagesavemode', '-dependencyversion', '-verbosity', '-solutiondirectory', '-apikey'),
  dotnet: S('-v', '--version', '-s', '--source', '-f', '--framework', '--package-directory', '--add-source', '--configfile', '--tool-path', '-a', '--arch', '--verbosity', '--tool-manifest'),
  pub: S('--git-url', '--git-ref', '--git-path', '--hosted-url', '--path', '--sdk', '--directory', '-C'),
};

const BOOL_WITH_VALUE = S('--strict-ssl', '--ignore-scripts', '--save-exact', '--global', '--save-dev', '--audit', '--fund', '--package-lock', '--frozen-lockfile');

function operand(toks          , i        , value                     )         {
  while (i < toks.length) {
    const t = toks[i];
    if (t === '--') return i + 1;
    if (t.length < 2 || t[0] !== '-') return i;
    i += !t.includes('=') && value.has(t) ? 2 : 1;
  }
  return i;
}

const NPM_INSTALL = S('install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'add', 'install-test', 'it');
const NPM_CI = S('ci', 'clean-install', 'ic', 'install-clean', 'isntall-clean');

function resolve(toks          )                  {
  const mgr = programOf(toks[0]);
  const verbAt = (value                     , from = 1) => operand(toks, from, value);

  if (/^(?:python[0-9.]*w?|py|pyw)$/.test(mgr)) {
    let i = 1;
    while (i < toks.length && toks[i].startsWith('-') && toks[i] !== '-m') i += toks[i] === '-X' || toks[i] === '-W' ? 2 : 1;
    if (toks[i] !== '-m' || !/^(?:pip[0-9.]*|uv|pipx|poetry|pdm|conda)$/.test(toks[i + 1] ?? '')) return null;
    const inner = resolve([toks[i + 1], ...toks.slice(i + 2)]);
    return inner ? { ...inner, at: inner.at + i + 1 } : null;
  }
  if (/^pip[0-9.]*$/.test(mgr)) {
    const v = verbAt(S('--python', '--log', '--log-file', '--proxy', '--retries', '--timeout', '--exists-action', '--trusted-host', '--cert', '--client-cert', '--cache-dir', '--use-feature', '--use-deprecated', '--keyring-provider'));
    return toks[v] === 'install' ? { ecosystem: 'pypi', manager: 'pip', verb: 'install', at: v + 1, value: VALUE.pypi } : null;
  }
  if (mgr === 'uvx') return { ecosystem: 'pypi', manager: 'uvx', verb: 'run', at: 1, runner: true, global: true, value: VALUE.pypi };
  if (mgr === 'uv') {
    const v = verbAt(S('--directory', '--project', '--cache-dir', '--config-file', '--color', '--python-preference', '--allow-insecure-host'));
    const [a, b] = [toks[v], toks[v + 1]];
    if (a === 'add') return { ecosystem: 'pypi', manager: 'uv', verb: 'add', at: v + 1, global: false, value: VALUE.pypi };
    if (a === 'sync') return { ecosystem: 'pypi', manager: 'uv', verb: 'sync', at: v + 1, manifestVerb: true, global: false, value: VALUE.pypi };
    if (a === 'pip' && b === 'install') return { ecosystem: 'pypi', manager: 'uv', verb: 'pip install', at: v + 2, value: VALUE.pypi };
    if (a === 'pip' && b === 'sync') return { ecosystem: 'pypi', manager: 'uv', verb: 'pip sync', at: v + 2, manifestVerb: true, value: VALUE.pypi };
    if (a === 'tool' && b === 'install') return { ecosystem: 'pypi', manager: 'uv', verb: 'tool install', at: v + 2, global: true, value: VALUE.pypi };
    if (a === 'tool' && b === 'run') return { ecosystem: 'pypi', manager: 'uv', verb: 'tool run', at: v + 2, runner: true, global: true, value: VALUE.pypi };
    return null;
  }
  if (mgr === 'pipx') {
    const v = verbAt(S());
    if (toks[v] === 'run') return { ecosystem: 'pypi', manager: 'pipx', verb: 'run', at: v + 1, runner: true, global: true, value: VALUE.pypi };
    if (toks[v] === 'install') return { ecosystem: 'pypi', manager: 'pipx', verb: 'install', at: v + 1, global: true, value: VALUE.pypi };
    if (toks[v] === 'inject') return { ecosystem: 'pypi', manager: 'pipx', verb: 'inject', at: operand(toks, v + 1, VALUE.pypi) + 1, global: true, value: VALUE.pypi };
    return null;
  }
  if (mgr === 'poetry' || mgr === 'pdm') {
    const v = verbAt(S('-C', '--directory', '-P', '--project', '-p'));
    if (toks[v] === 'add') return { ecosystem: 'pypi', manager: mgr, verb: 'add', at: v + 1, global: mgr === 'poetry' ? false : null, value: VALUE.pypi };
    if (toks[v] === 'install' || toks[v] === 'sync') return { ecosystem: 'pypi', manager: mgr, verb: toks[v], at: v + 1, manifestVerb: true, global: false, value: VALUE.pypi };
    return null;
  }
  if (mgr === 'conda' || mgr === 'mamba' || mgr === 'micromamba') {
    const v = verbAt(S('--rc-file', '-r', '--root-prefix'));
    if (toks[v] === 'install' || toks[v] === 'create') return { ecosystem: 'conda', manager: mgr, verb: toks[v], at: v + 1, value: VALUE.conda };
    if (toks[v] === 'env' && (toks[v + 1] === 'create' || toks[v + 1] === 'update')) return { ecosystem: 'conda', manager: mgr, verb: `env ${toks[v + 1]}`, at: v + 2, manifestVerb: true, value: VALUE.conda };
    return null;
  }

  if (mgr === 'npx' || mgr === 'bunx' || mgr === 'pnpx') return { ecosystem: 'npm', manager: mgr, verb: 'exec', at: 1, runner: true, global: true, value: VALUE.npm };
  if (mgr === 'npm') {
    const v = verbAt(VALUE.npm);
    const verb = toks[v] ?? '';
    if (verb === 'exec' || verb === 'x') return { ecosystem: 'npm', manager: 'npm', verb: 'exec', at: v + 1, runner: true, global: true, value: VALUE.npm };
    if (NPM_CI.has(verb)) return { ecosystem: 'npm', manager: 'npm', verb: 'ci', at: v + 1, manifestVerb: true, value: VALUE.npm };
    if (verb === 'create' || verb === 'init' || verb === 'innit') return { ecosystem: 'npm', manager: 'npm', verb: 'create', at: v + 1, runner: true, scaffold: true, global: true, value: VALUE.npm };
    return NPM_INSTALL.has(verb) ? { ecosystem: 'npm', manager: 'npm', verb: 'install', at: v + 1, value: VALUE.npm } : null;
  }
  if (mgr === 'pnpm') {
    const v = verbAt(VALUE.pnpm);
    const verb = toks[v] ?? '';
    if (verb === 'dlx') return { ecosystem: 'npm', manager: 'pnpm', verb: 'dlx', at: v + 1, runner: true, global: true, value: VALUE.pnpm };
    if (verb === 'create') return { ecosystem: 'npm', manager: 'pnpm', verb: 'create', at: v + 1, runner: true, scaffold: true, global: true, value: VALUE.pnpm };
    return verb === 'add' || verb === 'install' || verb === 'i' ? { ecosystem: 'npm', manager: 'pnpm', verb, at: v + 1, value: VALUE.pnpm } : null;
  }
  if (mgr === 'yarn') {
    let v = verbAt(VALUE.yarn);
    let global                 = null;
    if (toks[v] === 'workspace') v = operand(toks, v + 2, VALUE.yarn);
    if (toks[v] === 'global') {
      global = true;
      v = operand(toks, v + 1, VALUE.yarn);
    }
    const verb = toks[v];
    if (verb === undefined && toks.some((t) => /^(?:-v|--version|-h|--help)$/.test(t))) return null;
    if (verb === 'dlx') return { ecosystem: 'npm', manager: 'yarn', verb: 'dlx', at: v + 1, runner: true, global: true, value: VALUE.yarn };
    if (verb === 'create') return { ecosystem: 'npm', manager: 'yarn', verb: 'create', at: v + 1, runner: true, scaffold: true, global: true, value: VALUE.yarn };
    if (verb === 'add') return { ecosystem: 'npm', manager: 'yarn', verb: 'add', at: v + 1, global, value: VALUE.yarn };

    if (verb === undefined || verb === 'install') return { ecosystem: 'npm', manager: 'yarn', verb: 'install', at: v + 1, manifestVerb: true, global, value: VALUE.yarn };
    return null;
  }
  if (mgr === 'bun') {
    const v = verbAt(VALUE.bun);
    const verb = toks[v] ?? '';
    if (verb === 'x') return { ecosystem: 'npm', manager: 'bun', verb: 'x', at: v + 1, runner: true, global: true, value: VALUE.bun };
    if (verb === 'create' || verb === 'c') return { ecosystem: 'npm', manager: 'bun', verb: 'create', at: v + 1, runner: true, scaffold: true, global: true, value: VALUE.bun };
    return ['add', 'a', 'install', 'i'].includes(verb) ? { ecosystem: 'npm', manager: 'bun', verb, at: v + 1, value: VALUE.bun } : null;
  }
  if (mgr === 'deno') {
    const v = verbAt(S());
    return toks[v] === 'add' || toks[v] === 'install' || toks[v] === 'i' ? { ecosystem: 'jsr', manager: 'deno', verb: toks[v], at: v + 1, value: VALUE.deno } : null;
  }

  if (mgr === 'go') {
    const v = verbAt(S('-C'));
    if (toks[v] === 'get' || toks[v] === 'install') return { ecosystem: 'go', manager: 'go', verb: toks[v], at: v + 1, global: toks[v] === 'install', value: VALUE.go };
    if (toks[v] === 'mod' && toks[v + 1] === 'download') return { ecosystem: 'go', manager: 'go', verb: 'mod download', at: v + 2, manifestVerb: true, global: false, value: VALUE.go };
    return null;
  }
  if (mgr === 'cargo') {
    const v = verbAt(S('-Z', '--config', '-C', '--color'));
    return toks[v] === 'add' || toks[v] === 'install' ? { ecosystem: 'cargo', manager: 'cargo', verb: toks[v], at: v + 1, global: toks[v] === 'install', value: VALUE.cargo } : null;
  }
  if (mgr === 'gem') return toks[1] === 'install' || toks[1] === 'i' ? { ecosystem: 'rubygems', manager: 'gem', verb: 'install', at: 2, value: VALUE.rubygems } : null;
  if (mgr === 'bundle' || mgr === 'bundler') {
    if (toks[1] === 'add') return { ecosystem: 'rubygems', manager: 'bundle', verb: 'add', at: 2, global: false, value: VALUE.bundle };
    if (toks[1] === 'install') return { ecosystem: 'rubygems', manager: 'bundle', verb: 'install', at: 2, manifestVerb: true, global: false, value: VALUE.bundle };
    return null;
  }
  if (mgr === 'composer') {
    let v = verbAt(VALUE.composer);
    let global = false;
    if (toks[v] === 'global') {
      global = true;
      v = operand(toks, v + 1, VALUE.composer);
    }
    if (toks[v] === 'require' || toks[v] === 'req' || toks[v] === 'r') return { ecosystem: 'composer', manager: 'composer', verb: 'require', at: v + 1, global, value: VALUE.composer };
    if (toks[v] === 'install' || toks[v] === 'i') return { ecosystem: 'composer', manager: 'composer', verb: 'install', at: v + 1, manifestVerb: true, global, value: VALUE.composer };
    return null;
  }
  if (mgr === 'nuget') return (toks[1] ?? '').toLowerCase() === 'install' ? { ecosystem: 'nuget', manager: 'nuget', verb: 'install', at: 2, global: false, value: VALUE.nuget } : null;
  if (mgr === 'dotnet') {
    if (toks[1] === 'add') {
      const pi = toks.indexOf('package', 2);
      return pi > 0 && pi <= 3 ? { ecosystem: 'nuget', manager: 'dotnet', verb: 'add package', at: pi + 1, global: false, value: VALUE.dotnet } : null;
    }
    if (toks[1] === 'tool' && toks[2] === 'install') return { ecosystem: 'nuget', manager: 'dotnet', verb: 'tool install', at: 3, value: VALUE.dotnet };
    return null;
  }
  if (mgr === 'dart' || mgr === 'flutter') {
    if (toks[1] !== 'pub') return null;
    if (toks[2] === 'add') return { ecosystem: 'pub', manager: mgr, verb: 'add', at: 3, global: false, value: VALUE.pub };
    if (toks[2] === 'get') return { ecosystem: 'pub', manager: mgr, verb: 'get', at: 3, manifestVerb: true, global: false, value: VALUE.pub };
    return null;
  }
  return null;
}

const GO_MODULE_PATH = /^[a-z0-9][a-z0-9._~-]{0,127}\.[a-z0-9._~-]{1,127}(?:\/[a-zA-Z0-9._~-]{1,127}){1,32}$/i;

function pep440(spec                    )                     {
  const s = String(spec ?? '').trim();
  if (!s) return undefined;
  const exact = /^===?\s*([\w.+!-]+)$/.exec(s);
  return exact ? exact[1] : s.replace(/\s+/g, '');
}

function nameOf(t        , ecosystem               )                                            {
  let m                        ;
  switch (ecosystem) {
    case 'npm':
      m = /^(@?[a-z0-9][a-z0-9._~-]*(?:\/[a-z0-9._~-]+)?)(?:@(.{1,200}))?$/i.exec(t);
      return m && /[a-z]/i.test(m[1]) ? { name: m[1], version: m[2] } : null;
    case 'pypi':
      m = /^([a-z0-9][a-z0-9._-]*)(?:\[[^\]]*\])?\s*((?:===?|>=|<=|~=|!=|>|<)[^;]{0,200})?(?:;.*)?$/i.exec(t);
      return m && /[a-z]/i.test(m[1]) ? { name: m[1], version: pep440(m[2]) } : null;
    case 'conda':
      m = /^(?:[\w.-]+::)?([a-z0-9_][\w.-]*)(?:\s*((?:==?|>=|<=|!=|~=|>|<)[^\s]{0,200}))?$/i.exec(t);
      return m && /[a-z]/i.test(m[1]) ? { name: m[1], version: m[2] ? (m[2].startsWith('==') ? pep440(m[2]) : m[2]) : undefined } : null;
    case 'jsr':
      m = /^jsr:(@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*)(?:@(.{1,200}))?$/i.exec(t);
      return m ? { name: m[1], version: m[2] } : null;
    case 'go': {
      const at = t.indexOf('@');
      const path = at === -1 ? t : t.slice(0, at);
      const version = at === -1 ? undefined : t.slice(at + 1) || undefined;
      return GO_MODULE_PATH.test(path) ? { name: path, version } : null;
    }
    case 'cargo':
      m = /^([a-z0-9][a-z0-9._-]*)(?:@([\w.\-*^~><=]+))?$/i.exec(t);
      return m && /[a-z]/i.test(m[1]) ? { name: m[1], version: m[2] } : null;
    case 'rubygems':
      m = /^([a-z0-9][a-z0-9._-]*)(?::([\w.\-~><= ]{1,60}))?$/i.exec(t);
      return m && /[a-z]/i.test(m[1]) ? { name: m[1], version: m[2]?.trim() || undefined } : null;
    case 'nuget':
      m = /^([a-z0-9][\w.\-]*)$/i.exec(t);
      return m && /[a-z]/i.test(m[1]) ? { name: m[1] } : null;
    case 'composer':
      m = /^([a-z0-9][a-z0-9._-]*\/[a-z0-9._-]+)(?:[:=]([\w.\-*^~><=| ,@]{1,100}))?$/i.exec(t);
      return m ? { name: m[1], version: m[2]?.trim() || undefined } : null;
    case 'pub':
      m = /^([a-z0-9][a-z0-9_]*)(?::([\w.\-*^><= ]+))?$/i.exec(t);
      return m && /[a-z]/i.test(m[1]) ? { name: m[1], version: m[2]?.trim() || undefined } : null;
  }
}

const GIT_SPEC = /^(?:git\+|git:\/\/|git@|github:|gitlab:|bitbucket:|gist:)/i;
const HOSTED_GIT_URL = /^https?:\/\/(?:www\.)?(?:github\.com|gitlab\.com|bitbucket\.org)\/[^/\s]+\/[^/\s#]+?(?:\.git)?(?:#\S*)?$/i;
const LOCAL_SPEC = /^(?:file:|\.{1,2}(?:[/\\]|$)|\/|~[/\\]|[a-z]:[\\/])/i;
const ARCHIVE = /\.(?:tgz|tar\.gz|tar|zip|whl)$/i;

function gitRef(t        )                     {
  const hash = t.indexOf('#');
  if (hash >= 0) return t.slice(hash + 1).replace(/^(?:commit=|semver:)/, '') || undefined;
  const rev = /[?&]rev=([^&\s]+)/.exec(t);
  if (rev) return rev[1];
  const at = t.lastIndexOf('@');
  return at > t.lastIndexOf('/') ? t.slice(at + 1) || undefined : undefined;
}

function scaffoldPackage(spec        )         {
  const at = spec.indexOf('@', 1);
  const [name, version] = at > 0 ? [spec.slice(0, at), spec.slice(at)] : [spec, ''];
  if (name.startsWith('@')) {
    const slash = name.indexOf('/');
    return `${slash < 0 ? `${name}/create` : `${name.slice(0, slash)}/create-${name.slice(slash + 1)}`}${version}`;
  }
  return `${name.startsWith('create-') ? name : `create-${name}`}${version}`;
}

const PYPI_AT = S('poetry', 'pdm', 'pipx', 'uv', 'uvx');

function classify(raw        , ecosystem               , manager = '')                     {
  let t = raw.trim();
  let eco = ecosystem;

  if (t.includes('$')) {
    const why = t === RUNTIME_OPERAND ? 'the package names arrive at run time (xargs / find -exec / parallel input)' : `the package is named by ${t.slice(0, 60)} - only known at run time`;
    return { ecosystem: eco === 'jsr' ? 'npm' : eco, source: 'registry', name: t.slice(0, 120), unreadable: why };
  }

  const aliased = eco === 'npm' ? /^(@?[^@\s]{1,214})@((?:npm:|git\+|git:|github:|gitlab:|bitbucket:|file:|https?:|\.{1,2}\/)\S*)$/i.exec(t) : null;
  if (aliased) {
    const inner = classify(aliased[2].replace(/^npm:/i, ''), 'npm');
    return inner ? { ...inner, alias: aliased[1] } : null;
  }

  if (eco === 'jsr' && /^npm:/i.test(t)) {
    eco = 'npm';
    t = t.slice(4);
  }

  const direct = eco === 'pypi' ? /^([a-z0-9][\w.-]*)(?:\[[^\]]*\])?\s*@\s*((?:git\+|file:|https?:)\S*)$/i.exec(t) : null;
  if (direct) t = direct[2];
  if (GIT_SPEC.test(t) || (eco === 'npm' && HOSTED_GIT_URL.test(t))) return { ecosystem: eco, source: 'git', name: t, ref: gitRef(t) };
  if (/^https?:\/\//i.test(t)) return { ecosystem: eco, source: 'url', name: t };
  if (LOCAL_SPEC.test(t) || ((eco === 'pypi' || eco === 'npm') && ARCHIVE.test(t))) return { ecosystem: eco, source: 'file', name: t };

  if (eco === 'npm' && /^[\w.-]+\/[\w.-]+(?:#\S*)?$/.test(t)) return { ecosystem: eco, source: 'git', name: t, ref: gitRef(t) };
  if ((eco === 'pypi' || eco === 'npm') && /\.(?:txt|toml|cfg|lock|json)$/i.test(t)) return null;
  if (eco === 'pypi' && PYPI_AT.has(manager)) {

    const at = /^([a-z0-9][\w.-]*)(?:\[[^\]]*\])?@([^@/\s]{1,100})$/i.exec(t);
    if (at && /[a-z]/i.test(at[1])) return { ecosystem: eco, source: 'registry', name: at[1], ...(at[2] === 'latest' ? {} : { version: at[2] }) };
  }
  const parsed = nameOf(t, eco);
  if (!parsed) return null;
  return { ecosystem: eco, source: 'registry', name: parsed.name, ...(parsed.version ? { version: parsed.version } : {}) };
}

const RUNNER_PACKAGE_FLAG = /^(-p|--package|--from|--spec)$/;
const RUNNER_EXTRA_FLAG = /^--with$/;

function runnerSpecs(rest          , ecosystem               , value                     )           {
  const packages           = [];
  const extras           = [];
  let command                = null;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === '--') continue;
    const eq = /^(--package|--from|--spec|--with)=(.+)$/.exec(t);
    if (eq) {
      (eq[1] === '--with' ? extras : packages).push(eq[2]);
      continue;
    }
    if (RUNNER_PACKAGE_FLAG.test(t) || RUNNER_EXTRA_FLAG.test(t)) {
      if (rest[i + 1]) (RUNNER_EXTRA_FLAG.test(t) ? extras : packages).push(rest[i + 1]);
      i++;
      continue;
    }
    if (t.startsWith('-')) {
      if (!t.includes('=') && value.has(t)) i++;
      continue;
    }
    command = t;
    break;
  }
  const specs = packages.length ? [...packages, ...extras] : [...(command ? [command] : []), ...extras];
  return ecosystem === 'pypi' ? specs.map((x) => x.replace(/^([a-z0-9][a-z0-9._-]*)@(?=\d)/i, '$1==')) : specs;
}

function optionValue(toks          , names                     , caseless         )                {
  for (let i = 0; i < toks.length; i++) {
    const t = caseless ? toks[i].toLowerCase() : toks[i];
    if (names.has(t)) return toks[i + 1] ?? null;
    const eq = t.indexOf('=');
    if (eq > 0 && names.has(t.slice(0, eq))) return toks[i].slice(eq + 1);
  }
  return null;
}

const VERSION_FLAG                                               = {
  cargo: S('--version', '--vers'),
  gem: S('-v', '--version'),
  bundle: S('-v', '--version'),
  nuget: S('-version'),
  dotnet: S('--version', '-v'),
};

export function installCommand(toks          )                        {
  const r = resolve(toks);
  if (!r) return null;
  const caseless = r.manager === 'nuget';
  const rest = toks.slice(r.at);
  const specs                = [];
  let manifest = !!r.manifestVerb;

  if (toks.some((t) => t === '-h' || t === '--help' || t === '--dry-run')) return null;
  if (r.runner) {
    const operands = runnerSpecs(rest, r.ecosystem, r.value);

    if (r.scaffold && !operands.length) return null;
    for (const s of operands) {
      const spec = classify(r.scaffold && !s.includes('$') ? scaffoldPackage(s) : s, r.ecosystem, r.manager);
      if (spec) specs.push(spec);
    }
  } else {
    let last                     = null;
    for (let i = 0; i < rest.length && specs.length < 60; i++) {
      const t = rest[i];
      const f = caseless ? t.toLowerCase() : t;
      if (t.length > 1 && t[0] === '-') {
        last = null;
        const eq = f.indexOf('=');
        const flag = eq > 0 ? f.slice(0, eq) : f;
        const value = eq > 0 ? t.slice(eq + 1) : r.value.has(flag) ? rest[i + 1] : undefined;
        if (eq < 0 && r.value.has(flag)) i++;
        else if (eq < 0 && BOOL_WITH_VALUE.has(flag) && /^(?:true|false)$/i.test(rest[i + 1] ?? '')) i++;
        if (value === undefined) continue;

        if (/^(?:-r|--requirement|--file)$/.test(flag) && r.ecosystem !== 'rubygems') manifest = true;
        if (flag === '-e' || flag === '--editable') {
          const spec = classify(value, r.ecosystem);
          if (spec && spec.source === 'git') specs.push(spec);
          else manifest = true;
        }
        if ((r.manager === 'cargo' && flag === '--git') || (r.manager === 'bundle' && (flag === '--git' || flag === '--github'))) {
          specs.push({ ecosystem: r.ecosystem, source: 'git', name: flag === '--github' ? `github:${value}` : value });
        }
        if ((r.manager === 'cargo' || r.manager === 'bundle' || r.manager === 'dart' || r.manager === 'flutter') && flag === '--path') {
          specs.push({ ecosystem: r.ecosystem, source: 'file', name: value });
        }
        continue;
      }
      if (t === '--') continue;

      if (r.ecosystem === 'pypi' && (t === '.' || t === './')) {
        manifest = true;
        continue;
      }

      if (r.manager === 'composer' && last && !last.version && !t.includes('/')) {
        last.version = t;
        last = null;
        continue;
      }
      const spec = classify(t, r.ecosystem, r.manager);

      if (spec?.source === 'file' && r.ecosystem === 'go') {
        manifest = true;
        continue;
      }
      last = spec && spec.source === 'registry' ? spec : null;
      if (spec) specs.push(spec);
    }
    if (!specs.length && !manifest && r.verb !== 'require' && r.verb !== 'add' && r.verb !== 'add package' && r.verb !== 'tool install' && r.verb !== 'inject' && !(r.ecosystem === 'conda' && r.verb === 'create')) {

      manifest = r.ecosystem === 'npm' || r.ecosystem === 'jsr' || r.manager === 'uv' || r.manager === 'poetry' || r.manager === 'pdm';
    }
  }

  const vflag = r.verb === 'tool install' ? S('--version') : VERSION_FLAG[r.manager];
  const flagged = vflag ? optionValue(rest, vflag, caseless) : null;
  const registry = specs.filter((s) => s.source === 'registry');
  if (flagged && registry.length === 1 && !registry[0].version) registry[0].version = flagged;

  const refFlag = optionValue(rest, S('--rev', '--ref', '--tag', '--branch'), false);
  const gits = specs.filter((s) => s.source === 'git');
  if (gits.length && refFlag) for (const g of gits) g.ref ??= refFlag;

  const redirected = specs.some((s) => (s.source === 'git' || s.source === 'file') && (r.manager === 'cargo' || r.manager === 'bundle'));
  const kept = redirected ? specs.filter((s) => s.source !== 'registry') : specs;

  if (!kept.length && !manifest) return null;
  return { ecosystem: r.ecosystem, manager: r.manager, verb: r.verb, toks, runner: !!r.runner, manifest, global: r.global ?? null, specs: kept.slice(0, 60) };
}

const ADVISORY_ECOSYSTEMS                      = S('npm', 'pypi', 'go', 'cargo', 'rubygems', 'nuget', 'composer', 'pub');

export function installTargets(command                           )                  {
  const s = String(command ?? '');
  if (!s.trim()) return [];

  const out                  = [];
  const seen = new Set        ();

  for (const c of parseShell(s)) {
    const ic = installCommand(c.toks);
    if (!ic) continue;
    for (const spec of ic.specs) {
      if (spec.source !== 'registry' || spec.unreadable || !ADVISORY_ECOSYSTEMS.has(spec.ecosystem)) continue;
      const ecosystem = spec.ecosystem                    ;
      const key = `${ecosystem}:${spec.name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(spec.version ? { name: spec.name, version: spec.version, ecosystem } : { name: spec.name, ecosystem });
    }
  }

  return out;
}

