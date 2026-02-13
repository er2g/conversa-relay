#!/usr/bin/env node
import { getOutboxPaths, writeOutboxMessage } from '../src/outbox/common.js';

function parseArgs(argv) {
  const flags = {};
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const current = argv[i];
    if (current.startsWith('--')) {
      const key = current.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
      continue;
    }
    positional.push(current);
  }

  return { flags, positional };
}

function printUsage() {
  const lines = [
    'Kullanim:',
    '  node scripts/ai-outbox-message.js --type progress --text "Mesaj"',
    '',
    'Opsiyonlar:',
    '  --text, --message      Gonderilecek mesaj metni',
    '  --type                 start|progress|final|error|info',
    '  --chat                 Hedef chatId (opsiyonel, WA_CHAT_ID yoksa gerekli)',
    '  --request              Request id (opsiyonel, WA_REQUEST_ID yoksa otomatik bos)',
    '  --orchestrator         codex|claude|gemini (opsiyonel)',
    '  --outbox-dir           Outbox base dizini (opsiyonel)',
    '  --help                 Yardim metni'
  ];
  console.log(lines.join('\n'));
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  if (flags.help) {
    printUsage();
    process.exit(0);
  }

  const textValue = (flags.text || flags.message || positional.join(' ').trim())
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t');
  if (!textValue) {
    console.error('Hata: Mesaj metni gerekli (--text).');
    printUsage();
    process.exit(2);
  }

  const outboxPaths = getOutboxPaths(flags['outbox-dir'] || process.env.AI_OUTBOX_DIR);
  const result = await writeOutboxMessage(
    {
      chatId: flags.chat || process.env.WA_CHAT_ID,
      requestId: flags.request || process.env.WA_REQUEST_ID || null,
      orchestrator: flags.orchestrator || process.env.WA_ORCHESTRATOR || null,
      type: flags.type || 'progress',
      text: textValue
    },
    { outboxPaths }
  );

  console.log(
    JSON.stringify({
      ok: true,
      file: result.filePath,
      requestId: result.envelope.requestId,
      type: result.envelope.type
    })
  );
}

main().catch((error) => {
  console.error(`Hata: ${error?.message || String(error)}`);
  process.exit(1);
});
