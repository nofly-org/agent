import { callArgText } from './source-lines.mjs';

export const AGENT_FRAMEWORK_RE =
  /\b(?:AgentExecutor|initialize_agent|create_react_agent|create_openai_tools_agent|create_tool_calling_agent|langgraph|StateGraph|crewai|RoundRobinGroupChat|SelectorGroupChat|autogen_agentchat|autogen|Runner\.run|generateText|streamText|ToolLoopAgent|langchain|llama_index|smolagents|pydantic_ai|semantic_kernel)\b|from\s+agents\s+import|@openai\/agents|@ai-sdk\/|from\s+['"]ai['"]/;

const fileTextCache = new WeakMap();

export function fileText(ctx) {
  const lines = ctx?.lines ?? [];
  let text = fileTextCache.get(lines);
  if (text === undefined) {
    text = lines.join('\n');
    fileTextCache.set(lines, text);
  }
  return text;
}

const PICKS_TOOLS_RE =
  /\b\w+\.name\s+(?:not\s+)?in\b|\.name\s*(?:==|!=)|\b(?:selected_tools|spec_functions|exclude_tools|include_tools)\s*=|\binclude_release_tools\s*=\s*False\b/;
const HANDS_OVER_RE = /\.get_tools\s*\(|\.to_tool_list\s*\(/;
const READ_ONLY_DB_RE =
  /mode=ro\b|default_transaction_read_only|postgresql_readonly|isolation_level\s*=\s*['"]?READ ONLY|SET\s+(?:SESSION\s+CHARACTERISTICS\s+AS\s+)?TRANSACTION\s+READ\s+ONLY|ApplicationIntent=ReadOnly|read[_-]?only|readonly|\bro_user\b/i;
const READ_FILE_TOOLS = new Set(['read_file', 'list_directory', 'file_search']);

const TOOLKITS = [
  { name: 'GmailToolkit', key: 'gmail', does: 'send mail and create drafts as the account owner', reader: 'search and read mail', gate: 'sending' },
  { name: 'O365Toolkit', key: 'office365', does: 'send mail and calendar invitations as the account owner', reader: 'search mail and events', gate: 'sending' },
  { name: 'SlackToolkit', key: 'slack', does: 'post and schedule messages in the workspace', reader: 'read channels and messages', gate: 'posting' },
  { name: 'GitHubToolkit', key: 'github', does: 'create, change and delete files, branches and pull requests', reader: 'read the repository', gate: 'every change' },
  { name: 'GitLabToolkit', key: 'gitlab', does: 'create, change and delete files and merge requests', reader: 'read the repository', gate: 'every change' },
  { name: 'JiraToolkit', key: 'jira', does: 'create and change issues and make any Jira API call it composes', reader: 'search and read issues', gate: 'every change' },
  { name: 'GmailToolSpec', key: 'gmail_spec', does: 'create and send drafts as the account owner', reader: 'search and read mail', gate: 'sending' },
];

function wholeToolkit(t) {
  return {
    id: `python.agent_toolkit_${t.key}`,
    title: `Agent is handed the whole ${t.name}`,
    severity: 'MEDIUM',
    category: 'agentic',
    confidence: 0.7,
    re: new RegExp(`(?<!class )(?<!def )\\b${t.name}\\b\\s*(?:\\.\\s*from_\\w+\\s*)?\\(`),
    codeOnly: true,
    suppress: (_m, _unit, ctx) => {
      const text = fileText(ctx);
      return !HANDS_OVER_RE.test(text) || PICKS_TOOLS_RE.test(text) || new RegExp(`\\bclass\\s+${t.name}\\b`).test(text);
    },
    sink: () => `${t.name}.get_tools()`,
    source: 'agent tools',
    message:
      `Every tool in ${t.name} is given to the agent, so it can ${t.does}, not only ${t.reader}. ` +
      'Whatever the agent reads can carry an instruction, and one hidden in a message or a ticket can then use the tools the task never needed - the OWASP LLM03:2026 hijacked-assistant case, where an injected email forwards the inbox.',
    remediation:
      `Hand the agent only the tools the task uses (filter get_tools() by name, or build the read tools directly), grant the account a read-only scope, and put ${t.gate} behind a person's approval.`,
    cwe: 'CWE-250',
  };
}

function fullMailboxScope(lang) {
  return {
    id: `${lang}.gmail_full_scope`,
    title: 'Agent asks for full access to the mailbox',
    severity: 'MEDIUM',
    category: 'agentic',
    confidence: 0.7,
    re: /['"`]https:\/\/mail\.google\.com\/?['"`]/,
    suppress: (_m, _unit, ctx) => {
      const text = fileText(ctx);
      return !(AGENT_FRAMEWORK_RE.test(text) || /\bGmail(?:Toolkit|ToolSpec)\b/.test(text));
    },
    sink: () => 'https://mail.google.com/',
    source: 'OAuth scope',
    message:
      'The agent\'s Google credentials ask for https://mail.google.com/, the scope that reads, sends and permanently deletes everything in the mailbox. An agent that reads mail can work with gmail.readonly, which leaves an injected instruction nothing to send or delete with.',
    remediation:
      'Request https://www.googleapis.com/auth/gmail.readonly when the agent only reads (gmail.compose if it drafts replies for a person to send), and send through a separate path that a person approves.',
    cwe: 'CWE-250',
  };
}

const FILE_TOOLS_RE = /(?<!class )(?<!def )\b(FileManagementToolkit|WriteFileTool|DeleteFileTool|MoveFileTool|CopyFileTool|ReadFileTool|ListDirectoryTool|FileSearchTool)\s*\(/;

function listedTools(args) {
  const m = /\bselected_tools\s*=\s*\[([^\]]*)\]/.exec(args);
  if (!m) return null;
  return [...m[1].matchAll(/['"]([\w-]+)['"]/g)].map((x) => x[1]);
}

function fileToolReach(args, tool) {
  if (/\broot_dir\s*=/.test(args)) return 'bounded';
  if (/^(?:ReadFileTool|ListDirectoryTool|FileSearchTool)$/.test(tool)) return 'read';
  if (tool !== 'FileManagementToolkit') return 'write';
  if (!/\bselected_tools\s*=/.test(args)) return 'write';
  const listed = listedTools(args);
  return listed && listed.some((t) => !READ_FILE_TOOLS.has(t)) ? 'write' : 'read';
}

const FILE_TOOLS_WRITE = {
  id: 'python.file_tools_whole_disk',
  title: 'Agent file tools can write anywhere on disk',
  severity: 'HIGH',
  category: 'agentic',
  confidence: 0.8,
  re: FILE_TOOLS_RE,
  codeOnly: true,
  suppress: (m, unit) => fileToolReach(callArgText(unit, m.index), m[1]) !== 'write',
  sink: (m) => m[1],
  source: 'agent tools',
  message:
    'File tools are given to the agent with no root_dir, so they take any path the process can reach and can write, move or delete there. An instruction hidden in a file or a page the agent reads can overwrite a shell profile, a git hook or an authorized_keys file, which runs code or opens access the next time something starts.',
  remediation:
    'Pass root_dir set to the one working directory the task needs (the tools then refuse paths outside it), and selected_tools listing only the tools the task uses.',
  cwe: 'CWE-250',
};

const FILE_TOOLS_READ = {
  id: 'python.file_tools_read_whole_disk',
  title: 'Agent file tools can read anywhere on disk',
  severity: 'MEDIUM',
  category: 'agentic',
  confidence: 0.75,
  re: FILE_TOOLS_RE,
  codeOnly: true,
  suppress: (m, unit) => fileToolReach(callArgText(unit, m.index), m[1]) !== 'read',
  sink: (m) => m[1],
  source: 'agent tools',
  message:
    'Read-only file tools are given to the agent with no root_dir, so they read any path the process can reach - cloud credentials, SSH keys, other projects - and an injected instruction can ask for exactly those.',
  remediation: 'Pass root_dir set to the one directory the task needs; the tools then refuse paths outside it.',
  cwe: 'CWE-22',
};

const SQL_AGENT_DEF_RE = /\b(?:def\s+create_sql_agent|class\s+(?:SQLDatabaseToolkit|SQLDatabaseChain|NLSQLTableQueryEngine|SQLTableRetrieverQueryEngine|QuerySQLDatabaseTool|QuerySQLDataBaseTool|SqlToolkit|SqlDatabaseChain)\b|function\s+createSqlAgent\b)/;

const SQL_AGENT_BUILT_RE = /\b(?:create_sql_agent|createSqlAgent|SQLDatabaseChain|SqlDatabaseChain|NLSQLTableQueryEngine|SQLTableRetrieverQueryEngine)\b\s*(?:\.\s*(?:from_llm|fromLLM)\s*)?\(/;

function sqlAgent(lang) {
  return {
    id: `${lang}.sql_agent_writable`,
    title: 'Agent runs model-written SQL on a connection nothing makes read-only',
    severity: 'MEDIUM',
    category: 'agentic',
    confidence: 0.6,
    re:
      lang === 'python'
        ? /(?<!class )(?<!def )\b(create_sql_agent|SQLDatabaseToolkit|SQLDatabaseChain|NLSQLTableQueryEngine|SQLTableRetrieverQueryEngine|QuerySQLDatabaseTool|QuerySQLDataBaseTool)\b\s*(?:\.\s*from_llm\s*)?\(/
        : /(?<!class )(?<!function )\b(createSqlAgent|SqlToolkit|SqlDatabaseChain)\b\s*(?:\.\s*fromLLM\s*)?\(/,
    codeOnly: true,
    suppress: (m, _unit, ctx) => {
      const text = fileText(ctx);
      if (READ_ONLY_DB_RE.test(text) || SQL_AGENT_DEF_RE.test(text)) return true;
      return /Toolkit|Tool$/.test(m[1]) && SQL_AGENT_BUILT_RE.test(text);
    },
    sink: (m) => m[1],
    source: 'model-written SQL',
    message:
      'The agent executes whatever SQL the model writes, and nothing in this file opens the connection read-only. If the database user can write, a question or a stored row carrying an instruction can change or drop data. The role may well be read-only already - that is set in the database, where this scan cannot see.',
    remediation:
      'Connect as a database role that can only SELECT the tables the agent needs (the framework\'s own security note asks for this), open the connection read-only where the driver allows it (SQLite mode=ro, PostgreSQL default_transaction_read_only=on), and limit include_tables to what the task reads.',
    cwe: 'CWE-250',
  };
}

export function agencyRules(lang) {
  if (lang === 'js') return [fullMailboxScope('js'), sqlAgent('js')];
  return [...TOOLKITS.map(wholeToolkit), fullMailboxScope('python'), FILE_TOOLS_WRITE, FILE_TOOLS_READ, sqlAgent('python')];
}
