import { bold, cyan, dim, green, yellow } from '../core/terminal.mjs';
import { unreadMcpStores } from '../inventory/discovery/mcp-servers.mjs';
import { collectMcpInventory, displayPath } from '../mcp/inventory.mjs';

export function cmdMcpListInstalled(flags, cwd = process.cwd()) {
  const machine = !flags['no-machine'];
  const records = collectMcpInventory(cwd, [], { machine });
  const unread = unreadMcpStores().map((u) => ({ file: displayPath(u.file, cwd), state: u.state }));

  if (flags.json) {
    console.log(JSON.stringify({
      servers: records.map((r) => ({ name: r.name, names: r.names, kind: r.kind, command: r.command, url: r.url, package: r.package, disabled: r.disabled, locations: r.locations })),
      unread,
    }, null, 2));
    return;
  }

  const groups = new Map();
  for (const rec of records) {
    for (const loc of rec.locations) {
      const key = `${loc.scope === 'machine' ? 0 : 1}\u0000${loc.file}`;
      if (!groups.has(key)) groups.set(key, { loc, servers: [] });
      const group = groups.get(key);
      if (!group.servers.includes(rec)) group.servers.push(rec);
    }
  }
  const onMachine = records.filter((r) => r.locations.some((l) => l.scope === 'machine')).length;
  const inProject = records.filter((r) => r.locations.some((l) => l.scope === 'project')).length;
  const spread = [machine && `${onMachine} on this machine`, `${inProject} in this project`].filter(Boolean).join(' · ');
  console.log(bold(cyan('\n  MCP servers')) + dim(` - ${records.length} installed · ${spread}`));

  if (!records.length) {
    console.log(dim(`  (none found in ${machine ? "this machine's agent configs or " : ''}${displayPath(cwd, cwd) === '.' ? 'this folder' : cwd})`));
  }
  for (const [, { loc, servers }] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`\n  ${bold(loc.file)}${loc.vendor && loc.vendor !== 'project' ? dim(` (${loc.vendor})`) : ''}`);
    for (const rec of servers) {
      const launch = rec.kind === 'remote' ? rec.url : rec.command;
      console.log(`    ${rec.disabled ? dim('○') : green('●')} ${bold(rec.name)}${rec.disabled ? dim(' (disabled)') : ''} ${dim(launch ?? '')}`);
    }
  }
  for (const u of unread.slice(0, 3)) console.log(`\n  ${yellow('⚠')} ${dim(`${u.file} was not read (${u.state}) - servers in it are not listed.`)}`);
  console.log(`\n  ${dim('Check them for known vulnerabilities:')} ${bold('nofly mcps')}${dim(' · one file only:')} ${bold('nofly mcp list --config <file>')}\n`);
}
