import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanSourceFile } from '../src/detect/code-sast.mjs';

const ids = (text, file) => [...new Set(scanSourceFile(text, file).map((h) => h.ruleId))];
const has = (text, file, id) => ids(text, file).includes(id);

test('an agent handed a whole toolkit, the full mailbox scope or unbounded file tools is flagged', () => {
  const gmail = 'from langchain_google_community import GmailToolkit\ncredentials = get_gmail_credentials(scopes=["https://mail.google.com/"])\ntoolkit = GmailToolkit(api_resource=build_resource_service(credentials=credentials))\nagent = create_react_agent(llm, toolkit.get_tools())\n';
  assert.ok(has(gmail, 'agent.py', 'python.agent_toolkit_gmail'));
  assert.ok(has(gmail, 'agent.py', 'python.gmail_full_scope'));
  assert.ok(has('tools = FileManagementToolkit().get_tools()\n', 'agent.py', 'python.file_tools_whole_disk'));
  assert.ok(has('tools = [ReadFileTool()]\n', 'agent.py', 'python.file_tools_read_whole_disk'));
  assert.ok(has('db = SQLDatabase.from_uri(url)\nagent = create_sql_agent(llm, db=db)\n', 'agent.py', 'python.sql_agent_writable'));
  assert.ok(has('const executor = createSqlAgent(model, toolkit);\n', 'agent.ts', 'js.sql_agent_writable'));
});

test('the same agents built the narrow way are left alone', () => {
  assert.deepEqual(ids('tools = [t for t in toolkit.get_tools() if t.name in {"search_gmail"}]\ntoolkit = GmailToolkit()\n', 'agent.py').filter((i) => i.startsWith('python.agent_toolkit')), []);
  assert.ok(!has('toolkit = FileManagementToolkit(root_dir="/workspace")\n', 'agent.py', 'python.file_tools_whole_disk'));
  assert.ok(!has('db = SQLDatabase.from_uri("sqlite:///file:app.db?mode=ro&uri=true")\nagent = create_sql_agent(llm, db=db)\n', 'agent.py', 'python.sql_agent_writable'));
  assert.ok(!has('SCOPES = ["https://mail.google.com/"]\nservice = build("gmail", "v1", credentials=creds)\n', 'cleanup.py', 'python.gmail_full_scope'));
});

test('a model load that refuses safetensors is flagged', () => {
  assert.ok(has('model = AutoModel.from_pretrained("org/m", use_safetensors=False)\n', 'load.py', 'python.safetensors_refused'));
  assert.ok(!has('model = AutoModel.from_pretrained("org/m", use_safetensors=True)\n', 'load.py', 'python.safetensors_refused'));
});

test('model output rendered as Markdown with no image policy is flagged, a policy or a docs page is not', () => {
  const chat = "import { Streamdown } from 'streamdown';\nimport { useChat } from '@ai-sdk/react';\nexport function Chat() {\n  const { messages } = useChat();\n  return messages.map((m) => <Streamdown key={m.id}>{m.content}</Streamdown>);\n}\n";
  assert.ok(has(chat, 'components/chat.tsx', 'js.model_markdown_remote_images'));
  assert.ok(!has(chat.replace('key={m.id}', "allowedImagePrefixes={['https://cdn.example.com']}"), 'components/chat.tsx', 'js.model_markdown_remote_images'));
  assert.ok(!has("import ReactMarkdown from 'react-markdown';\nexport default function Doc({ source }) {\n  return <ReactMarkdown>{source}</ReactMarkdown>;\n}\n", 'pages/docs/[slug].tsx', 'js.model_markdown_remote_images'));
});
