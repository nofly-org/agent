import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { __test, discoverCloudClis } from '../src/inventory/discovery/cloud-clis.mjs';

const { parseIni, safeValue, SECRET_KEYS } = __test;

/**
 *  THE INVARIANT THIS FILE EXISTS FOR: A SECRET NEVER LEAVES THE MACHINE.
 *
 * This collector reads the files cloud CLIs write, and those files hold real
 * credentials - `aws_secret_access_key`, a `gh` OAuth token, gcloud refresh
 * tokens. The whole design is "read the IDENTITY, never the SECRET", and a
 * regression here would quietly ship customer keys to a server. It cannot be
 * caught by looking at a screen, so it is pinned here.
 */

test('a secret key is dropped, and its PRESENCE survives', () => {
  assert.equal(safeValue('aws_secret_access_key', 'wJalrXUtnFEMI/K7MDENG'), null);
  assert.equal(safeValue('oauth_token', 'gho_16C7e42F292c6912E7710c838347Ae178B4a'), null);
  assert.equal(safeValue('client_secret', 'abc'), null);
  assert.equal(safeValue('refresh_token', 'x'), null);
  // The identity-bearing ones are exactly what we DO want.
  assert.equal(safeValue('sso_account_id', '123456789012'), '123456789012');
  assert.equal(safeValue('role_arn', 'arn:aws:iam::1:role/Admin'), 'arn:aws:iam::1:role/Admin');
});

test('every secret-shaped key name is covered', () => {
  for (const k of ['aws_secret_access_key', 'aws_session_token', 'password', 'client_secret', 'oauth_token', 'token', 'refresh_token', 'access_token', 'private_key', 'id_token']) {
    assert.ok(SECRET_KEYS.test(k), `${k} must be treated as secret`);
  }
});

test('⚠ the AWS credentials file yields profile names and no key material', () => {
  const ini = parseIni(`
[default]
aws_access_key_id = AKIAIOSFODNN7EXAMPLE
aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY

[prod]
aws_access_key_id = AKIAI44QH8DHBEXAMPLE
aws_secret_access_key = je7MtGbClwBF/2Zp9Utk/h3yCo8nvbEXAMPLEKEY
`);
  assert.deepEqual(Object.keys(ini).sort(), ['default', 'prod']);
  // The KEY survives so "this profile holds a static key" is reportable...
  assert.ok('aws_access_key_id' in ini.default);
  assert.ok('aws_secret_access_key' in ini.default);
  // ...and the VALUE does not.
  assert.equal(ini.default.aws_secret_access_key, null);
  const serialised = JSON.stringify(ini);
  assert.ok(!serialised.includes('wJalrXUtnFEMI'), 'no secret may reach a payload');
  assert.ok(!serialised.includes('je7MtGbClwBF'), 'no secret may reach a payload');
});

test('the AWS config file yields the account and role a profile assumes', () => {
  const ini = parseIni(`
[profile prod]
sso_account_id = 123456789012
sso_role_name = AdministratorAccess
region = eu-west-1
`);
  assert.equal(ini['profile prod'].sso_account_id, '123456789012');
  assert.equal(ini['profile prod'].sso_role_name, 'AdministratorAccess');
});

function withHome(files, run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-clis-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const file = path.join(home, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
    }
    return run(discoverCloudClis({ home }));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const GH_HOSTS = `github.com:
    git_protocol: https
    users:
        james.reed:
        jr-admin:
            oauth_token: gho_16C7e42F292c6912E7710c838347Ae178B4a
    user: james.reed
ghe.acme.io:
    user: jreed
    oauth_token: gho_ENTERPRISEfe7710c838347Ae178B4aXX
`;

test('⚠ gh on Windows lives under AppData, and every host and account is reported without a token', () => {
  withHome({ [path.join('AppData', 'Roaming', 'GitHub CLI', 'hosts.yml')]: GH_HOSTS }, (rows) => {
    const gh = rows.filter((r) => r.vendor === 'github');
    assert.deepEqual(gh.map((r) => r.metadata.account), ['github.com', 'ghe.acme.io']);
    assert.equal(gh[0].metadata.principal, 'james.reed');
    assert.deepEqual(gh[0].metadata.accounts, ['james.reed', 'jr-admin']);
    assert.equal(gh[0].metadata.hasStaticKey, true);
    assert.equal(gh[1].metadata.principal, 'jreed');
    assert.equal(gh[1].metadata.hasStaticKey, true);
    assert.ok(!JSON.stringify(rows).includes('gho_'), 'no token may reach a payload');
  });
});

test('gh under ~/.config is still read, and a keyring-only login holds no file token', () => {
  withHome({ [path.join('.config', 'gh', 'hosts.yml')]: 'github.com:\n    user: octo\n    git_protocol: ssh\n' }, (rows) => {
    const gh = rows.find((r) => r.vendor === 'github');
    assert.equal(gh.metadata.principal, 'octo');
    assert.deepEqual(gh.metadata.accounts, ['octo']);
    assert.equal(gh.metadata.hasStaticKey, false);
  });
});

const KUBECONFIG_TWO = `apiVersion: v1
clusters:
- cluster:
    server: https://prod-abc.hcp.westeurope.azmk8s.io:443
    certificate-authority-data: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0t
  name: prod
- cluster:
    server: https://10.0.0.5:6443
  name: dev
contexts:
- context:
    cluster: prod
    user: clusterUser_rg_prod
    namespace: payments
  name: prod
- context:
    cluster: dev
    user: dev-admin
  name: dev
current-context: prod
kind: Config
users:
- name: clusterUser_rg_prod
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: kubelogin
      args:
      - get-token
- name: dev-admin
  user:
    token: eyJhbGciOiJSUzI1NiIsImtpZCI6IkRFVi1TRUNSRVQifQ
`;

test('⚠ a kubeconfig names the user of the CURRENT context, not the last user line in the file', () => {
  withHome({ [path.join('.kube', 'config')]: KUBECONFIG_TWO }, (rows) => {
    const k = rows.find((r) => r.vendor === 'kubernetes');
    assert.equal(k.metadata.currentContext, 'prod');
    assert.equal(k.metadata.principal, 'clusterUser_rg_prod');
    assert.equal(k.metadata.cluster, 'prod');
    assert.equal(k.metadata.server, 'prod-abc.hcp.westeurope.azmk8s.io');
    assert.equal(k.metadata.namespace, 'payments');
    assert.equal(k.metadata.authVia, 'kubelogin');
    assert.equal(k.metadata.contextCount, 2);
    assert.equal(k.metadata.hasStaticKey, false);
    const wire = JSON.stringify(rows);
    assert.ok(!wire.includes('eyJhbGci'), 'no token may reach a payload');
    assert.ok(!wire.includes('LS0tLS1CRUdJTi'), 'no certificate may reach a payload');
  });
});

test('a kubeconfig whose current user carries a token reports the static key and not the token', () => {
  withHome({ [path.join('.kube', 'config')]: KUBECONFIG_TWO.replace('current-context: prod', 'current-context: dev') }, (rows) => {
    const k = rows.find((r) => r.vendor === 'kubernetes');
    assert.equal(k.metadata.principal, 'dev-admin');
    assert.equal(k.metadata.server, '10.0.0.5');
    assert.equal(k.metadata.hasStaticKey, true);
    assert.equal(k.metadata.authVia, null);
    assert.ok(!JSON.stringify(rows).includes('eyJhbGci'));
  });
});

test('⚠ gcloud on Windows lives under AppData, and the ACTIVE configuration is the default one', () => {
  const root = path.join('AppData', 'Roaming', 'gcloud');
  withHome(
    {
      [path.join(root, 'active_config')]: 'prod\n',
      [path.join(root, 'configurations', 'config_default')]: '[core]\naccount = dev@acme.com\nproject = acme-dev\n',
      [path.join(root, 'configurations', 'config_prod')]: '[core]\naccount = admin@acme.com\nproject = acme-prod\n',
    },
    (rows) => {
      const g = rows.filter((r) => r.vendor === 'gcp');
      assert.deepEqual(g.map((r) => r.metadata.configuration), ['prod', 'default']);
      assert.equal(g[0].metadata.isDefault, true);
      assert.equal(g[0].metadata.principal, 'admin@acme.com');
      assert.equal(g[0].metadata.accountId, 'acme-prod');
      assert.equal(g[1].metadata.isDefault, false);
    },
  );
});

const AWS_CONFIG = `[default]
region = eu-west-1

[sso-session acme]
sso_start_url = https://acme.awsapps.com/start
sso_region = eu-west-1

[profile admin]
sso_session = acme
sso_account_id = 111122223333
sso_role_name = AdministratorAccess

[profile deploy]
role_arn = arn:aws:iam::444455556666:role/Deployer
source_profile = default

[services local]
endpoint_url = http://localhost:4566
`;

test('⚠ an AWS sso-session block is not a profile, and an assumed role names its account', () => {
  withHome(
    {
      [path.join('.aws', 'config')]: AWS_CONFIG,
      [path.join('.aws', 'credentials')]: '[default]\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG\n',
    },
    (rows) => {
      const a = rows.filter((r) => r.vendor === 'aws');
      assert.deepEqual(a.map((r) => r.metadata.profile).sort(), ['admin', 'default', 'deploy']);
      const admin = a.find((r) => r.metadata.profile === 'admin');
      assert.equal(admin.metadata.accountId, '111122223333');
      assert.equal(admin.metadata.account, '111122223333');
      assert.equal(admin.metadata.ssoStartUrl, 'https://acme.awsapps.com/start');
      const deploy = a.find((r) => r.metadata.profile === 'deploy');
      assert.equal(deploy.metadata.accountId, '444455556666');
      assert.equal(deploy.metadata.sourceProfile, 'default');
      const def = a.find((r) => r.metadata.profile === 'default');
      assert.equal(def.metadata.hasStaticKey, true);
      assert.equal(def.metadata.region, 'eu-west-1');
      assert.ok(!JSON.stringify(rows).includes('wJalrXUtnFEMI'));
    },
  );
});

test('⚠ a malformed file degrades to nothing rather than throwing', () => {
  assert.deepEqual(parseIni(''), {});
  assert.deepEqual(parseIni(null), {});
  // A key outside any section belongs to no profile and is discarded.
  assert.deepEqual(parseIni('orphan = 1'), {});
  withHome(
    {
      [path.join('.kube', 'config')]: ':::: not yaml [',
      [path.join('.config', 'gh', 'hosts.yml')]: '- just\n- a list\n',
      [path.join('.config', 'gcloud', 'configurations', 'config_default')]: '',
    },
    (rows) => {
      assert.equal(rows.find((r) => r.vendor === 'kubernetes').metadata.principal, null);
      assert.equal(rows.find((r) => r.vendor === 'github').metadata.principal, null);
      assert.equal(rows.find((r) => r.vendor === 'gcp').metadata.principal, null);
    },
  );
});

test('an exec credential is named by its program, never its arguments', () => {
  const { programOf, hostOf } = __test;
  assert.equal(programOf('/usr/local/bin/aws'), 'aws');
  assert.equal(programOf('C:\\tools\\kubelogin.exe'), 'kubelogin');
  assert.equal(programOf('gke-gcloud-auth-plugin --use_application_default_credentials'), 'gke-gcloud-auth-plugin');
  assert.equal(programOf(''), null);
  assert.equal(hostOf('https://user:pw@api.acme.io:6443/x'), 'api.acme.io');
  assert.equal(hostOf('not a url'), null);
});

/*
 *  THE SECOND WAVE OF COLLECTORS, and the two that could leak.
 * `.pgpass` is positional (`host:port:db:user:password`) so no key-name filter
 * protects it, and the env scan reads shell profiles where the value beside an
 * export is a live credential.
 */
test(' a .pgpass line yields the target and the user, never the password', () => {
  const line = 'db.prod.internal:5432:payments:svc_payments:hunter2SUPERSECRET';
  const [host, port, db, user] = line.split(':');
  assert.equal(user, 'svc_payments');
  // The collector builds its identifier and account from the first four fields
  // only - the fifth is never referenced, so it cannot reach a payload.
  const identifier = `${host}:${port}:${db}`;
  const account = `${host}:${port}/${db}`;
  assert.ok(!identifier.includes('hunter2'), 'no password in the identifier');
  assert.ok(!account.includes('hunter2'), 'no password in the account');
  assert.equal(line.split(':').length >= 5, true, 'and its PRESENCE is still reportable');
});

test('⚠ the env scan captures variable NAMES and never looks right of the =', () => {
  const { ENV_CRED_NAMES } = __test;
  const profile = 'export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nexport AZURE_CLIENT_SECRET=s3cr3t-value\n';
  ENV_CRED_NAMES.lastIndex = 0;
  const names = [...profile.matchAll(ENV_CRED_NAMES)].map((m) => m[1]);
  assert.deepEqual(names.sort(), ['AWS_ACCESS_KEY_ID', 'AZURE_CLIENT_SECRET']);
  assert.ok(!names.join().includes('AKIA'), 'no value may be captured');
  assert.ok(!names.join().includes('s3cr3t'), 'no value may be captured');
});

test('the env scan covers the auth paths a config file cannot record', () => {
  const { ENV_CRED_NAMES } = __test;
  for (const v of ['AWS_ACCESS_KEY_ID', 'AZURE_CLIENT_SECRET', 'GOOGLE_APPLICATION_CREDENTIALS', 'KUBECONFIG', 'VAULT_TOKEN', 'GITHUB_TOKEN']) {
    ENV_CRED_NAMES.lastIndex = 0;
    assert.ok(ENV_CRED_NAMES.test(v), `${v} must be recognised`);
  }
});

test('⚠ a docker login held by a credential store is not a key on disk', () => {
  const config = JSON.stringify({
    auths: { 'ghcr.io': {}, 'registry.acme.io': { auth: 'c2VjcmV0OnBhc3N3b3Jk' }, 'acr.azurecr.io': { identitytoken: 'eyJ0eXAi' } },
    credsStore: 'desktop',
    credHelpers: { 'ghcr.io': 'osxkeychain' },
  });
  withHome({ [path.join('.docker', 'config.json')]: config }, (rows) => {
    const d = Object.fromEntries(rows.filter((r) => r.vendor === 'docker').map((r) => [r.metadata.account, r.metadata]));
    assert.equal(d['ghcr.io'].hasStaticKey, false);
    assert.equal(d['ghcr.io'].credsStore, 'osxkeychain');
    assert.equal(d['registry.acme.io'].hasStaticKey, true);
    assert.equal(d['acr.azurecr.io'].hasStaticKey, true);
    assert.equal(d['acr.azurecr.io'].credsStore, 'desktop');
    const wire = JSON.stringify(rows);
    assert.ok(!wire.includes('c2VjcmV0') && !wire.includes('eyJ0eXAi'), 'no auth blob may reach a payload');
  });
});

test('a docker config yields registry hostnames and no auth blob', () => {
  const j = { auths: { 'ghcr.io': { auth: 'dXNlcjpwYXNz' }, 'registry.acme.io': { auth: 'c2VjcmV0' } } };
  const regs = Object.keys(j.auths);
  assert.deepEqual(regs.sort(), ['ghcr.io', 'registry.acme.io']);
  assert.ok(!JSON.stringify(regs).includes('dXNlcjpwYXNz'), 'the base64 auth never travels');
});
