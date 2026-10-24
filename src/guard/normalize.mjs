
export function normalizeGuardInput(agent, payload) {
  const shaped = normalizeGuardShape(agent, payload);
  const norm = typeof shaped.tool_input === 'string' ? { ...shaped, tool_input: objectArgs(shaped.tool_input) } : shaped;

  const parent = parentSessionFrom(agent, payload);
  return parent ? { ...norm, parent_session_id: parent } : norm;
}

export function parentSessionFrom(agent, payload) {
  const p = payload || {};
  const candidates = [

    p.parent_session_id,
    p.parentSessionId,
    agent === 'cursor' ? p.parent_conversation_id : undefined,
    agent === 'windsurf' ? p.parent_trajectory_id : undefined,
    agent === 'cline' ? p.parent_task_id : undefined,

    process.env.NOFLY_PARENT_SESSION_ID,
  ];
  const self = String(p.session_id ?? p.conversation_id ?? p.task_id ?? p.trajectory_id ?? '').trim();
  for (const c of candidates) {
    const v = typeof c === 'string' ? c.trim() : '';

    if (v && v.length <= 200 && v !== self) return v;
  }
  return undefined;
}

/**
 * ⚠ COPILOT SENDS `toolArgs` AS A JSON STRING. Passed through, every key read
 * downstream (`command`, `file_path`, `content`) was undefined - the command
 * was never screened locally - and the server refuses a string `tool_input`
 * outright, so the escalation failed validation and fell open. Parsed here;
 * a string that is not a JSON object is kept, wrapped, so nothing is dropped.
 */
export function objectArgs(v) {
  if (typeof v !== 'string') return v;
  try {
    const parsed = JSON.parse(v);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    /* not JSON - fall through */
  }
  return { raw: v };
}

function normalizeGuardShape(agent, payload) {
  switch (agent) {
    case 'cursor': {
      /**
       * ⚠ TOOL NAME FIRST. `beforeMCPExecution` for a STDIO server carries the
       * server's launch line in `command` (`npx -y @wonderwhy-er/desktop-commander`)
       * beside the real `tool_name` / `tool_input`; reading `command` first graded
       * the server's launcher as a Bash call and dropped what the tool was asked
       * to do. And a bare tool name became `mcp__<tool>` - the tool read as the
       * SERVER with an empty leaf, so no exec or write leaf ever matched.
       */
      if ((payload.tool_name || payload.tool) && payload.hook_event_name !== 'beforeShellExecution') {
        const name = String(payload.tool_name || payload.tool);
        const server = String(payload.server_name ?? payload.server ?? payload.mcp_server ?? 'cursor').replace(/__/g, '_') || 'cursor';
        return { tool_name: name.startsWith('mcp__') ? name : `mcp__${server}__${name}`, tool_input: payload.tool_input ?? payload.arguments, tool_response: payload.tool_response ?? payload.result ?? jsonOrText(payload.result_json), cwd: payload.cwd || payload.workspace_roots?.[0], session_id: payload.conversation_id };
      }
      if (typeof payload.command === 'string') {
        return { tool_name: 'Bash', tool_input: { command: payload.command }, tool_response: typeof payload.output === 'string' ? payload.output : undefined, cwd: payload.cwd || payload.workspace_roots?.[0], session_id: payload.conversation_id };
      }
      if (payload.tool_name || payload.tool) {
        const name = payload.tool_name || payload.tool;
        return { tool_name: String(name).startsWith('mcp') ? name : `mcp__${name}`, tool_input: payload.tool_input ?? payload.arguments, tool_response: payload.tool_response ?? payload.result, cwd: payload.cwd, session_id: payload.conversation_id };
      }
      if (typeof payload.file_path === 'string' && Array.isArray(payload.edits)) {
        const written = payload.edits.map((e) => (typeof e?.new_string === 'string' ? e.new_string : '')).filter(Boolean).join('\n');
        return { tool_name: 'MultiEdit', tool_input: { file_path: payload.file_path, edits: payload.edits }, tool_response: written || undefined, cwd: payload.cwd || payload.workspace_roots?.[0], session_id: payload.conversation_id };
      }
      if (typeof payload.file_path === 'string') {
        return { tool_name: 'Edit', tool_input: { file_path: payload.file_path, content: payload.content ?? payload.new_content }, tool_response: payload.content ?? payload.new_content, cwd: payload.cwd || payload.workspace_roots?.[0], session_id: payload.conversation_id };
      }
      return { tool_name: payload.hook_event_name || 'unknown', tool_input: payload, session_id: payload.conversation_id };
    }
    case 'windsurf': {
      const info = payload.tool_info || {};
      if (typeof info.command_line === 'string') return { tool_name: 'Bash', tool_input: { command: info.command_line }, cwd: info.cwd ?? payload.cwd, session_id: payload.trajectory_id };
      /**
       * ⚠ `pre_mcp_tool_use` NAMED THE EVENT, NOT THE TOOL. With no
       * `command_line` and no `file_path` the fallback below made the tool
       * `pre_mcp_tool_use` and the input the whole `tool_info` - so an MCP call
       * carried no `mcp__` prefix, matched no exec leaf, and a desktop-commander
       * `execute_command npm i x` through Windsurf escalated to nobody. Mapped to
       * the same `mcp__<server>__<tool>` name every other vendor produces.
       */
      if (typeof info.tool_name === 'string' && info.tool_name.trim()) {
        const server = String(info.server_name ?? info.server ?? payload.server_name ?? 'windsurf').replace(/__/g, '_') || 'windsurf';
        const name = info.tool_name.startsWith('mcp__') ? info.tool_name : `mcp__${server}__${info.tool_name}`;
        return { tool_name: name, tool_input: info.tool_input ?? info.arguments ?? info.args ?? info.params ?? {}, tool_response: info.result, cwd: info.cwd ?? payload.cwd, session_id: payload.trajectory_id };
      }
      /**
       * ⚠ `pre_write_code` sends `edits: [{ old_string, new_string }]`, not
       * `content` - read as `content: undefined` it was an Edit of nothing, and no
       * post-edit file could be built. Mapped to the MultiEdit shape.
       */
      if (typeof info.file_path === 'string' && Array.isArray(info.edits) && typeof info.content !== 'string') {
        return { tool_name: 'MultiEdit', tool_input: { file_path: info.file_path, edits: info.edits }, tool_response: info.result, cwd: info.cwd ?? payload.cwd, session_id: payload.trajectory_id };
      }
      if (typeof info.file_path === 'string') return { tool_name: 'Edit', tool_input: { file_path: info.file_path, content: info.content }, tool_response: info.result, cwd: info.cwd ?? payload.cwd, session_id: payload.trajectory_id };
      return { tool_name: payload.agent_action_name || 'unknown', tool_input: info, tool_response: info.result, session_id: payload.trajectory_id };
    }
    case 'copilot':
      return {
        tool_name: payload.toolName || payload.tool_name,
        tool_input: objectArgs(payload.toolArgs ?? payload.tool_input),
        tool_response: payload.toolResult?.textResultForLlm ?? payload.tool_result?.text_result_for_llm ?? payload.toolResponse ?? payload.tool_response,
        cwd: payload.cwd,
        session_id: payload.sessionId || payload.session_id,
      };
    case 'cline':
      return clineShape(payload);
    case 'gemini': {
      const mcp = payload.mcp_context;
      const server = typeof mcp?.server_name === 'string' ? mcp.server_name.trim().replace(/__/g, '_') : '';
      const leaf = typeof mcp?.tool_name === 'string' ? mcp.tool_name.trim() : '';
      const name = server && leaf && !String(payload.tool_name ?? '').startsWith('mcp__') ? `mcp__${server}__${leaf}` : payload.tool_name;
      return { tool_name: name, tool_input: payload.tool_input, tool_response: payload.tool_response, cwd: payload.cwd, session_id: payload.session_id };
    }
    case 'codex':
    case 'claude':
    case 'aider':
    default:
      return { tool_name: payload.tool_name, tool_input: payload.tool_input, tool_response: payload.tool_response, cwd: payload.cwd, session_id: payload.session_id };
  }
}

function clineParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
  return Object.fromEntries(Object.entries(params).map(([k, v]) => [k, k === 'arguments' ? objectArgs(v) : v]));
}

function clineCommands(input) {
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) return input.map(clineCommands).filter(Boolean).join('\n');
  if (!input || typeof input !== 'object') return '';
  if ('commands' in input) return clineCommands(input.commands);
  if (typeof input.command === 'string') return Array.isArray(input.args) && input.args.length ? `${input.command} ${input.args.map((a) => (/[\s"]/.test(String(a)) ? JSON.stringify(String(a)) : String(a))).join(' ')}` : input.command;
  if (typeof input.cmd === 'string') return input.cmd;
  return '';
}

function clineTool(name, input) {
  const i = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  switch (name) {
    case 'use_mcp_tool': {
      const server = String(i.server_name || 'server').replace(/__/g, '_');
      return { tool_name: `mcp__${server}__${i.tool_name || i.name || 'tool'}`, tool_input: objectArgs(i.arguments) ?? i };
    }
    case 'run_commands':
      return { tool_name: 'Bash', tool_input: { command: clineCommands(input) } };
    case 'editor':
      if (typeof i.old_text === 'string') return { tool_name: 'Edit', tool_input: { file_path: i.path, old_string: i.old_text, new_string: i.new_text } };
      if (i.insert_line != null) return { tool_name: 'Edit', tool_input: { file_path: i.path, old_string: '', new_string: i.new_text } };
      return { tool_name: 'Write', tool_input: { file_path: i.path, content: i.new_text } };
    case 'apply_patch':
      return { tool_name: 'apply_patch', tool_input: typeof input === 'string' ? { input } : i };
    case 'fetch_web_content':
      return { tool_name: 'WebFetch', tool_input: { url: i.requests?.[0]?.url, ...i } };
    case 'read_files': {
      const first = (i.files ?? i.paths ?? [])[0];
      return { tool_name: 'Read', tool_input: { file_path: typeof first === 'string' ? first : first?.path, ...i } };
    }
    default:
      return { tool_name: name, tool_input: input };
  }
}

function clineShape(payload) {
  const call = payload.tool_call ?? payload.tool_result;
  const legacy = payload.preToolUse ?? payload.postToolUse;
  const name = call?.name ?? legacy?.toolName ?? payload.tool_name ?? payload.tool ?? payload.name;
  const input = call?.input ?? clineParams(legacy?.parameters) ?? payload.tool_input ?? payload.input ?? payload.arguments ?? payload.params;
  const response = payload.tool_result?.output ?? payload.postToolUse?.result ?? payload.tool_response ?? payload.result;
  const mapped = name === 'use_mcp_tool' && payload.server_name ? clineTool(name, { server_name: payload.server_name, ...input }) : clineTool(name, input);
  return {
    ...mapped,
    tool_response: response,
    cwd: payload.workspaceRoots?.[0] ?? payload.cwd,
    session_id: payload.taskId ?? payload.task_id ?? payload.session_id,
  };
}

function jsonOrText(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
